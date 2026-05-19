import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "./config.js";
import { buildMessageFingerprint } from "./services/fingerprint.js";
import { BridgeMetrics } from "./services/bridge-metrics.js";
import { repairMessages } from "./services/message-repairer.js";
import {
  buildRequestHashPayload,
  consumeSseEvent,
  createStreamAssemblerState,
  extractAssistantMessageFromCompletion,
  finalizeStreamAssistantMessage,
  isStreamAssemblyComplete
} from "./services/reasoning-extractor.js";
import {
  buildAnchorKey,
  buildBootstrapKey,
  buildDownstreamNamespace,
  findBestSessionCandidate,
  resolveExplicitSessionKey
} from "./services/session-key-resolver.js";
import { createSessionStore } from "./store/session-store.js";
import type {
  AssistantMessageSnapshot,
  ChatCompletionRequest,
  ChatMessage,
  JsonObject,
  SessionMatchCandidate,
  SessionRecord,
  UpstreamErrorShape
} from "./types.js";
import { canonicalJson } from "./utils/canonical.js";
import { sha256 } from "./utils/hash.js";

const config = loadConfig();
const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024
});
const metrics = new BridgeMetrics();

function nowOnly(): { now: number } {
  return { now: Date.now() };
}

async function ensureSession(
  sessionKey: string,
  anchorKey: string,
  bootstrapKey: string | undefined,
  model: string,
  store: Awaited<ReturnType<typeof createSessionStore>>
): Promise<SessionRecord> {
  const existing = await store.get(sessionKey);
  if (existing) {
    await store.touch(sessionKey);
    if (bootstrapKey) {
      await store.setBootstrapKey(sessionKey, bootstrapKey);
    }
    await store.addContextKey(sessionKey, anchorKey);
    return existing;
  }

  const { now } = nowOnly();
  const created: SessionRecord = {
    sessionKey,
    anchorKey,
    bootstrapKey,
    model,
    createdAt: now,
    updatedAt: now,
    contextKeys: [anchorKey],
    turns: [],
    requestHashes: [],
    inflightRequests: []
  };
  await store.set(created);
  return created;
}

function qualifyKey(namespaceKey: string, value: string): string {
  return `${namespaceKey}:${value}`;
}

function makeTurnId(sessionKey: string, requestHash: string, assistant: AssistantMessageSnapshot): string {
  return sha256(
    JSON.stringify({
      sessionKey,
      requestHash,
      content: assistant.content,
      tool_calls: assistant.tool_calls,
      reasoning_content: assistant.reasoning_content
    })
  );
}

async function saveAssistantTurn(
  sessionKey: string,
  requestHash: string,
  responseId: string | undefined,
  repairedRequestMessages: ChatMessage[],
  assistantMessage: AssistantMessageSnapshot,
  store: Awaited<ReturnType<typeof createSessionStore>>
): Promise<boolean> {
  const session = await store.get(sessionKey);
  if (!session) {
    return false;
  }

  const assistantIndex = repairedRequestMessages.filter((message) => message.role === "assistant").length;
  const turnId = makeTurnId(sessionKey, requestHash, assistantMessage);
  const { now } = nowOnly();

  return store.appendTurn(sessionKey, {
    turnId,
    responseId,
    requestHash,
    assistantIndex,
    historyMessageIndex: repairedRequestMessages.length,
    message: assistantMessage,
    fingerprint: buildMessageFingerprint(assistantMessage),
    createdAt: now
  });
}

function summarizeErrorBody(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as UpstreamErrorShape;
    const message = parsed.error && typeof parsed.error.message === "string"
      ? parsed.error.message
      : bodyText;
    return `upstream ${status}: ${message}`;
  } catch {
    return `upstream ${status}: ${bodyText}`;
  }
}

function copyUpstreamHeaders(upstream: Response, reply: FastifyReply): void {
  for (const [key, value] of upstream.headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "transfer-encoding" ||
      normalizedKey === "content-length" ||
      normalizedKey === "content-encoding" ||
      normalizedKey === "content-md5" ||
      normalizedKey === "etag"
    ) {
      continue;
    }
    reply.header(key, value);
  }
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return typeof value === "string" && value.length ? value : undefined;
}

function buildForwardHeaders(
  headers: Record<string, string | string[] | undefined>,
  requestIp: string,
  upstreamApiKey: string
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length"
  ]);

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (hopByHop.has(key) || key === "authorization") {
      continue;
    }
    const value = normalizeHeaderValue(rawValue);
    if (!value) {
      continue;
    }
    forwarded[key] = value;
  }

  const existingForwardedFor = normalizeHeaderValue(headers["x-forwarded-for"]);
  forwarded["x-forwarded-for"] = existingForwardedFor
    ? `${existingForwardedFor}, ${requestIp}`
    : requestIp;

  if (!forwarded["x-real-ip"]) {
    forwarded["x-real-ip"] = requestIp;
  }
  if (!forwarded["x-forwarded-proto"]) {
    forwarded["x-forwarded-proto"] = "http";
  }
  if (!forwarded["user-agent"]) {
    forwarded["user-agent"] = "reasoning-bridge";
  }

  forwarded["x-bridge-client-ip"] = requestIp;
  if (forwarded["user-agent"]) {
    forwarded["x-bridge-client-user-agent"] = forwarded["user-agent"];
  }
  forwarded["authorization"] = `Bearer ${upstreamApiKey}`;
  forwarded["content-type"] = "application/json";

  return forwarded;
}

function collectSseEvents(chunkText: string, buffer: string): { nextBuffer: string; events: string[] } {
  const combined = buffer + chunkText;
  const parts = combined.split(/\r?\n\r?\n/);
  const nextBuffer = parts.pop() ?? "";
  const events = parts;
  return { nextBuffer, events };
}

function parseSseEventData(rawEvent: string): string[] {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
  }
  return false;
}

async function proxyStream(
  reply: FastifyReply,
  upstream: Response,
  onEventData: (data: string) => void
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    throw new Error("upstream stream missing body");
  }

  reply.raw.writeHead(upstream.status);
  let buffer = "";
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    reply.raw.write(value);
    const text = decoder.decode(value, { stream: true });
    const parsed = collectSseEvents(text, buffer);
    buffer = parsed.nextBuffer;
    for (const event of parsed.events) {
      for (const data of parseSseEventData(event)) {
        onEventData(data);
      }
    }
  }

  if (buffer) {
    for (const data of parseSseEventData(buffer)) {
      onEventData(data);
    }
  }
  reply.raw.end();
}

interface UpstreamResponseHandle {
  response: Response;
  cleanup: () => void;
}

async function forwardToUpstream(body: JsonObject): Promise<UpstreamResponseHandle> {
  return forwardToUpstreamWithHeaders(body, {}, "127.0.0.1");
}

async function forwardToUpstreamWithHeaders(
  body: JsonObject,
  requestHeaders: Record<string, string | string[] | undefined>,
  requestIp: string
): Promise<UpstreamResponseHandle> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearTimeout(timer);
  };

  try {
    const response = await fetch(`${config.upstreamBaseUrl}${config.upstreamPath}`, {
      method: "POST",
      headers: buildForwardHeaders(requestHeaders, requestIp, config.upstreamApiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function upstreamFetchErrorStatus(error: unknown): number {
  return isAbortError(error) ? 504 : 502;
}

async function sendUpstreamReadError(
  reply: FastifyReply,
  error: unknown,
  sessionKey: string,
  requestHash: string,
  store: Awaited<ReturnType<typeof createSessionStore>>,
  closeRequest: (nextOutcome: "success" | "failure") => void
): Promise<void> {
  await store.clearInflight(sessionKey, requestHash);
  const message = error instanceof Error ? error.message : "unknown upstream error";
  const status = upstreamFetchErrorStatus(error);
  if (status === 504) {
    metrics.recordUpstreamTimeout();
  }
  closeRequest("failure");
  reply.code(status).send({
    error: {
      code: "upstream_unavailable",
      message
    }
  });
}

function buildWarningHeaders(missingAssistantIndexes: number[], reply: FastifyReply): void {
  if (missingAssistantIndexes.length) {
    appendWarning(reply, `missing-reasoning-for-assistant-indexes:${missingAssistantIndexes.join(",")}`);
  }
}

function appendWarning(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("x-reasoning-bridge-warning");
  if (typeof existing === "string" && existing.length) {
    reply.header("x-reasoning-bridge-warning", `${existing};${value}`);
    return;
  }
  reply.header("x-reasoning-bridge-warning", value);
}

function isRecentFallbackEligible(body: ChatCompletionRequest): boolean {
  return getMissingReasoningAssistantIndexes(body.messages).length > 0;
}

function canDisableThinking(body: ChatCompletionRequest): boolean {
  return typeof body.reasoning_effort === "string";
}

function disableThinkingMode(body: ChatCompletionRequest): ChatCompletionRequest {
  const nextBody = { ...body };
  delete nextBody.reasoning_effort;
  return nextBody;
}

function getMissingReasoningAssistantIndexes(messages: ChatMessage[]): number[] {
  return messages
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter((item) => item.message.role === "assistant" && !item.message.reasoning_content)
    .map((item) => item.messageIndex);
}

function countEligibleAssistantMessages(messages: ChatMessage[]): number {
  return getMissingReasoningAssistantIndexes(messages).length;
}

function isConfidentSessionCandidate(candidate: SessionMatchCandidate | undefined): boolean {
  if (!candidate) {
    return false;
  }
  if (candidate.matchedTurns <= 0) {
    return false;
  }
  if (candidate.score < config.sessionMatchMinScore) {
    return false;
  }
  if (candidate.candidateCount > 1 && candidate.scoreGap < config.sessionMatchMinMargin) {
    return false;
  }
  return true;
}

function buildLowConfidenceWarning(
  candidate: SessionMatchCandidate | undefined,
  resolvedBy: "explicit" | "bootstrap" | "context-key" | "recent-fallback" | "created"
): string {
  if (!candidate) {
    return `low-confidence-session-match:source=${resolvedBy},score=0,gap=0,matched=0`;
  }
  return `low-confidence-session-match:source=${candidate.source},score=${candidate.score},gap=${candidate.scoreGap},matched=${candidate.matchedTurns}`;
}

function handleLowConfidence(
  reply: FastifyReply,
  body: ChatCompletionRequest,
  resolvedBy: "explicit" | "bootstrap" | "context-key" | "recent-fallback" | "created",
  bestCandidate: SessionMatchCandidate | undefined
): ChatCompletionRequest | undefined {
  if (resolvedBy === "explicit" || !isRecentFallbackEligible(body)) {
    return body;
  }

  if (isConfidentSessionCandidate(bestCandidate)) {
    return body;
  }

  appendWarning(reply, buildLowConfidenceWarning(bestCandidate, resolvedBy));

  if (config.lowConfidenceStrategy === "reject") {
    reply.code(409).send({
      error: {
        code: "low_confidence_session_match",
        message: "Bridge could not safely recover the prior assistant reasoning state for this request."
      }
    });
    return undefined;
  }

  if (config.lowConfidenceStrategy === "disable-thinking") {
    if (canDisableThinking(body)) {
      appendWarning(reply, "thinking-disabled-by-bridge");
      return disableThinkingMode(body);
    }

    reply.code(409).send({
      error: {
        code: "low_confidence_reasoning_repair_required",
        message: "Bridge could not safely recover prior reasoning_content, and this request does not expose an explicit thinking toggle to disable before forwarding."
      }
    });
    return undefined;
  }

  return body;
}

function handleUnrepairedThinkingMode(
  reply: FastifyReply,
  body: ChatCompletionRequest,
  missingAssistantIndexes: number[]
): ChatCompletionRequest | undefined {
  if (!missingAssistantIndexes.length) {
    return body;
  }

  appendWarning(reply, `unrepaired-reasoning-for-assistant-indexes:${missingAssistantIndexes.join(",")}`);

  if (config.lowConfidenceStrategy === "reject") {
    reply.code(409).send({
      error: {
        code: "unrepaired_reasoning_content",
        message: "Bridge could not repair all assistant reasoning_content values required by thinking mode."
      }
    });
    return undefined;
  }

  if (config.lowConfidenceStrategy === "disable-thinking") {
    if (canDisableThinking(body)) {
      appendWarning(reply, "thinking-disabled-after-repair");
      return disableThinkingMode(body);
    }

    reply.code(409).send({
      error: {
        code: "unrepaired_reasoning_content",
        message: "Bridge could not repair all assistant reasoning_content values, and this request does not expose an explicit thinking toggle to disable before forwarding."
      }
    });
    return undefined;
  }

  appendWarning(reply, "unrepaired-reasoning-forwarded");
  return body;
}

app.setErrorHandler((error, request, reply) => {
  const message = error instanceof Error ? error.message : "unknown error";
  request.log.error({ err: error }, "unhandled bridge error");
  reply.code(500).send({
    error: {
      code: "bridge_internal_error",
      message
    }
  });
});

async function start(): Promise<void> {
  const storeOptions = {
    filePath: config.sessionStoreFilePath,
    redisKeyPrefix: config.redisKeyPrefix,
    limits: {
      maxSessions: config.maxSessions,
      maxTurnsPerSession: config.maxTurnsPerSession,
      maxStoreBytes: config.maxStoreBytes
    },
    ...(config.redisUrl ? { redisUrl: config.redisUrl } : {})
  };
  const store = await createSessionStore(config.sessionStoreDriver, storeOptions);

  setInterval(() => {
    void store.cleanup();
  }, config.cleanupIntervalMs).unref();

  app.get("/healthz", async () => ({
    ok: true,
    service: "reasoning-bridge"
  }));

  app.get("/debug/status", async () => {
    const storeStats = await store.getStats(10);
    return {
      ok: true,
      service: "reasoning-bridge",
      config: {
        host: config.host,
        port: config.port,
        upstreamBaseUrl: config.upstreamBaseUrl,
        upstreamPath: config.upstreamPath,
        sessionStoreDriver: config.sessionStoreDriver,
        recentFallbackLimit: config.recentFallbackLimit,
        recentFallbackMinScore: config.recentFallbackMinScore,
        sessionMatchMinScore: config.sessionMatchMinScore,
        sessionMatchMinMargin: config.sessionMatchMinMargin,
        lowConfidenceStrategy: config.lowConfidenceStrategy,
        allowUserScopedSessions: config.allowUserScopedSessions,
        maxSessions: config.maxSessions,
        maxTurnsPerSession: config.maxTurnsPerSession,
        maxStoreBytes: config.maxStoreBytes
      },
      runtime: metrics.snapshot(),
      store: storeStats
    };
  });

  app.get("/debug/metrics", async () => ({
    ok: true,
    runtime: metrics.snapshot()
  }));

  app.get("/debug/store", async (request: FastifyRequest) => {
    const query = request.query as { limit?: string | number } | undefined;
    const rawLimit = typeof query?.limit === "string" || typeof query?.limit === "number"
      ? Number(query.limit)
      : 10;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 10;

    return {
      ok: true,
      store: await store.getStats(limit)
    };
  });

  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ChatCompletionRequest;
    if (!body || !Array.isArray(body.messages) || typeof body.model !== "string") {
      return reply.code(400).send({
        error: {
          code: "bad_request",
          message: "Expected OpenAI-style chat completion body with model and messages"
        }
      });
    }

    const stream = Boolean(body.stream);
    metrics.beginRequest(stream);
    let outcome: "success" | "failure" = "failure";
    let requestClosed = false;
    const closeRequest = (nextOutcome: "success" | "failure"): void => {
      if (requestClosed) {
        return;
      }
      requestClosed = true;
      metrics.endRequest(stream, nextOutcome);
    };

    try {
      const downstreamNamespace = buildDownstreamNamespace(request.headers, request.ip);
      let workingBody = body;
      const rawAnchorKey = buildAnchorKey(workingBody);
      const rawBootstrapKey = buildBootstrapKey(workingBody);
      const anchorKey = qualifyKey(downstreamNamespace.namespaceKey, rawAnchorKey);
      const bootstrapKey = rawBootstrapKey ? qualifyKey(downstreamNamespace.namespaceKey, rawBootstrapKey) : undefined;
      const explicit = resolveExplicitSessionKey(
        { body: workingBody, headers: request.headers },
        { allowUserScopedSessions: config.allowUserScopedSessions }
      );
      let resolved = explicit ? {
        ...explicit,
        sessionKey: qualifyKey(downstreamNamespace.namespaceKey, explicit.sessionKey),
        anchorKey: qualifyKey(downstreamNamespace.namespaceKey, explicit.anchorKey)
      } : undefined;
      let resolvedBy: "explicit" | "bootstrap" | "context-key" | "recent-fallback" | "created" = explicit ? "explicit" : "created";
      let contextSessions: SessionRecord[] = [];
      let bootstrapSessions: SessionRecord[] = [];
      let bestCandidate: SessionMatchCandidate | undefined;

      if (!resolved) {
        contextSessions = await store.listByAnchor(anchorKey);
        bootstrapSessions = bootstrapKey ? await store.listByBootstrapKey(bootstrapKey) : [];

        bestCandidate =
          findBestSessionCandidate(
            { body: workingBody, headers: request.headers },
            bootstrapSessions,
            "bootstrap",
            true
          ) ??
          findBestSessionCandidate(
            { body: workingBody, headers: request.headers },
            contextSessions,
            "context-key",
            true
          );
      }

      if (!resolved && bestCandidate) {
        resolved = {
          sessionKey: bestCandidate.sessionKey,
          anchorKey: bestCandidate.anchorKey,
          source: bestCandidate.source
        };
        resolvedBy = bestCandidate.source;
      }

      if (!resolved && isRecentFallbackEligible(workingBody)) {
        const recentSessions = (await store.listRecent(config.recentFallbackLimit))
          .filter((session) => session.sessionKey.startsWith(`${downstreamNamespace.namespaceKey}:`));

        const recentFallback = findBestSessionCandidate(
          { body: workingBody, headers: request.headers },
          recentSessions,
          "recent-fallback"
        );
        if (recentFallback) {
          bestCandidate = recentFallback;
          if (recentFallback.score >= config.recentFallbackMinScore) {
            resolved = {
              sessionKey: recentFallback.sessionKey,
              anchorKey: recentFallback.anchorKey,
              source: recentFallback.source
            };
            resolvedBy = recentFallback.source;
          }
        }
      }

      if (!resolved) {
        resolved = {
          sessionKey: `${anchorKey}:root`,
          anchorKey,
          source: "context-key"
        };
        resolvedBy = "created";
      }

      const maybeAdjustedBody = handleLowConfidence(reply, workingBody, resolvedBy, bestCandidate);
      if (!maybeAdjustedBody) {
        metrics.recordLowConfidence("reject");
        closeRequest("failure");
        return;
      }
      if (maybeAdjustedBody !== workingBody) {
        metrics.recordLowConfidence("disable-thinking");
      } else if (resolvedBy !== "explicit" && isConfidentSessionCandidate(bestCandidate)) {
        metrics.recordLowConfidence("allowed");
      } else if (resolvedBy !== "explicit" && isRecentFallbackEligible(workingBody)) {
        metrics.recordLowConfidence("warn");
      }
      workingBody = maybeAdjustedBody;
      metrics.recordResolution(resolvedBy);

      const session = await ensureSession(resolved.sessionKey, resolved.anchorKey, bootstrapKey, body.model, store);
      await store.addContextKey(session.sessionKey, anchorKey);
      if (bootstrapKey) {
        await store.setBootstrapKey(session.sessionKey, bootstrapKey);
      }

      const repairResult = repairMessages(workingBody.messages, session);
      let repairedBody: ChatCompletionRequest = {
        ...workingBody,
        messages: repairResult.repairedMessages
      };
      const eligibleAssistantMessages = countEligibleAssistantMessages(workingBody.messages);
      const repairedAssistantMessages = repairResult.repairedAssistantIndexes.length;
      const finalMissingAssistantIndexes = getMissingReasoningAssistantIndexes(repairResult.repairedMessages);
      const missingAssistantMessages = finalMissingAssistantIndexes.length;
      metrics.recordRepair(eligibleAssistantMessages, repairedAssistantMessages, missingAssistantMessages);

      const maybeFinalBody = handleUnrepairedThinkingMode(reply, repairedBody, finalMissingAssistantIndexes);
      if (!maybeFinalBody) {
        metrics.recordLowConfidence("reject");
        closeRequest("failure");
        return;
      }
      if (maybeFinalBody !== repairedBody) {
        metrics.recordLowConfidence("disable-thinking");
        repairedBody = maybeFinalBody;
        workingBody = maybeFinalBody;
      }

      const requestHash = sha256(canonicalJson(buildRequestHashPayload(repairedBody)));
      await store.markInflight(session.sessionKey, {
        requestHash,
        startedAt: Date.now(),
        stream: Boolean(body.stream)
      });

      buildWarningHeaders(finalMissingAssistantIndexes, reply);

      request.log.info({
        namespaceKey: downstreamNamespace.namespaceKey,
        sessionKey: session.sessionKey,
        source: resolved.source,
        anchorKey,
        bootstrapKey: bootstrapKey ?? null,
        contextCandidateSessions: contextSessions.length,
        bootstrapCandidateSessions: bootstrapSessions.length,
        bestCandidateScore: bestCandidate?.score ?? 0,
        bestCandidateSecondScore: bestCandidate?.secondBestScore ?? 0,
        bestCandidateScoreGap: bestCandidate?.scoreGap ?? 0,
        bestCandidateMatchedTurns: bestCandidate?.matchedTurns ?? 0,
        bestCandidateCount: bestCandidate?.candidateCount ?? 0,
        lowConfidenceStrategy: config.lowConfidenceStrategy,
        stream: Boolean(workingBody.stream),
        matchCount: repairResult.matches.length,
        repairedAssistantIndexes: repairResult.repairedAssistantIndexes,
        missingAssistantIndexes: finalMissingAssistantIndexes,
        thinkingDisabled: !repairedBody.reasoning_effort && Boolean(body.reasoning_effort)
      }, "request repaired");

      if (config.logBody) {
        request.log.info({
          originalMessages: body.messages,
          repairedMessages: repairedBody.messages
        }, "request body details");
      }

      let upstreamHandle: UpstreamResponseHandle;
      try {
        upstreamHandle = await forwardToUpstreamWithHeaders(
          repairedBody,
          request.headers,
          request.ip
        );
      } catch (error) {
        await sendUpstreamReadError(reply, error, session.sessionKey, requestHash, store, closeRequest);
        return;
      }
      const { response: upstream, cleanup: cleanupUpstream } = upstreamHandle;

      copyUpstreamHeaders(upstream, reply);
      metrics.recordUpstreamStatus(upstream.status);
      reply.header("x-reasoning-bridge-session-key", session.sessionKey);
      reply.header("x-reasoning-bridge-session-source", resolved.source);
      reply.header("x-reasoning-bridge-anchor-key", anchorKey);
      if (bootstrapKey) {
        reply.header("x-reasoning-bridge-bootstrap-key", bootstrapKey);
      }
      reply.header("x-reasoning-bridge-namespace-key", downstreamNamespace.namespaceKey);
      reply.header("x-reasoning-bridge-match-score", String(bestCandidate?.score ?? 0));
      reply.header("x-reasoning-bridge-request-model", repairedBody.model);

      if (!upstream.ok) {
        let errorBody: string;
        try {
          errorBody = await upstream.text();
        } catch (error) {
          cleanupUpstream();
          await sendUpstreamReadError(reply, error, session.sessionKey, requestHash, store, closeRequest);
          return;
        }
        cleanupUpstream();
        await store.clearInflight(session.sessionKey, requestHash);
        closeRequest("failure");
        return reply.code(upstream.status).send({
          error: {
            code: "upstream_error",
            message: summarizeErrorBody(upstream.status, errorBody),
            upstream_status: upstream.status,
            upstream_body: errorBody
          }
        });
      }

      if (workingBody.stream) {
        reply.hijack();
        const assembler = createStreamAssemblerState();

        try {
          await proxyStream(reply, upstream, (data) => consumeSseEvent(assembler, data));
          cleanupUpstream();
          const streamComplete = isStreamAssemblyComplete(assembler);
          if (!streamComplete) {
            request.log.warn({
              sessionKey: session.sessionKey,
              requestHash,
              responseId: assembler.responseId
            }, "stream ended without terminal event");
            metrics.recordStreamInterruption();
          }
          const assistantMessage = finalizeStreamAssistantMessage(assembler);
          if (assistantMessage) {
            await saveAssistantTurn(session.sessionKey, requestHash, assembler.responseId, repairedBody.messages, assistantMessage, store);
          }
          outcome = streamComplete ? "success" : "failure";
        } catch (error) {
          cleanupUpstream();
          request.log.error({ err: error }, "stream proxy failed");
          if (isAbortError(error)) {
            metrics.recordUpstreamTimeout();
          }
          metrics.recordStreamInterruption();
          if (!reply.raw.destroyed && !reply.raw.writableEnded) {
            reply.raw.end();
          }
        } finally {
          await store.clearInflight(session.sessionKey, requestHash);
          closeRequest(outcome);
        }
        return;
      }

      let rawText: string;
      try {
        rawText = await upstream.text();
      } catch (error) {
        cleanupUpstream();
        await sendUpstreamReadError(reply, error, session.sessionKey, requestHash, store, closeRequest);
        return;
      }
      cleanupUpstream();
      await store.clearInflight(session.sessionKey, requestHash);

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        outcome = "success";
        closeRequest(outcome);
        return reply.type(upstream.headers.get("content-type") ?? "application/json").send(rawText);
      }

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { model?: unknown }).model !== "string"
      ) {
        (parsed as { model?: string }).model = repairedBody.model;
      }

      const assistantMessage = extractAssistantMessageFromCompletion(parsed);
      if (assistantMessage) {
        await saveAssistantTurn(
          session.sessionKey,
          requestHash,
          typeof (parsed as { id?: unknown }).id === "string" ? (parsed as { id: string }).id : undefined,
          repairedBody.messages,
          assistantMessage,
          store
        );
      }

      outcome = "success";
      closeRequest(outcome);

      return reply
        .code(upstream.status)
        .type(upstream.headers.get("content-type") ?? "application/json")
        .send(parsed);
    } catch (error) {
      closeRequest("failure");
      throw error;
    }
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info({
    host: config.host,
    port: config.port,
    upstream: `${config.upstreamBaseUrl}${config.upstreamPath}`,
    sessionStoreDriver: config.sessionStoreDriver,
    sessionStoreFilePath: config.sessionStoreFilePath,
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    maxSessions: config.maxSessions,
    maxTurnsPerSession: config.maxTurnsPerSession,
    maxStoreBytes: config.maxStoreBytes
  }, "reasoning bridge started");
}

start().catch((error) => {
  app.log.error({ err: error }, "failed to start reasoning bridge");
  process.exit(1);
});
