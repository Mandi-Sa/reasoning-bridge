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
  finalizeStreamAssistantMessage
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

async function forwardToUpstream(body: JsonObject): Promise<Response> {
  return forwardToUpstreamWithHeaders(body, {}, "127.0.0.1");
}

async function forwardToUpstreamWithHeaders(
  body: JsonObject,
  requestHeaders: Record<string, string | string[] | undefined>,
  requestIp: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    return await fetch(`${config.upstreamBaseUrl}${config.upstreamPath}`, {
      method: "POST",
      headers: buildForwardHeaders(requestHeaders, requestIp, config.upstreamApiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildWarningHeaders(missingAssistantIndexes: number[], reply: FastifyReply): void {
  if (missingAssistantIndexes.length) {
    reply.header("x-reasoning-bridge-warning", `missing-reasoning-for-assistant-indexes:${missingAssistantIndexes.join(",")}`);
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
  return body.messages.some((message) => message.role === "assistant" && !message.reasoning_content);
}

function shouldDisableThinking(body: ChatCompletionRequest): boolean {
  return typeof body.reasoning_effort === "string";
}

function disableThinkingMode(body: ChatCompletionRequest): ChatCompletionRequest {
  const nextBody = { ...body };
  delete nextBody.reasoning_effort;
  return nextBody;
}

function countEligibleAssistantMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => message.role === "assistant" && !message.reasoning_content).length;
}

function handleLowConfidence(
  reply: FastifyReply,
  body: ChatCompletionRequest,
  bestCandidate: SessionMatchCandidate | undefined
): ChatCompletionRequest | undefined {
  if (!isRecentFallbackEligible(body)) {
    return body;
  }

  if (
    bestCandidate &&
    (bestCandidate.source === "bootstrap" || bestCandidate.source === "context-key") &&
    (bestCandidate.candidateCount === 1 || bestCandidate.score > 0)
  ) {
    return body;
  }

  const score = bestCandidate?.score ?? 0;
  if (score >= config.recentFallbackMinScore) {
    return body;
  }

  appendWarning(reply, `low-confidence-session-match:score=${score}`);

  if (config.lowConfidenceStrategy === "reject") {
    reply.code(409).send({
      error: {
        code: "low_confidence_session_match",
        message: "Bridge could not safely recover the prior assistant reasoning state for this request."
      }
    });
    return undefined;
  }

  if (config.lowConfidenceStrategy === "disable-thinking" && shouldDisableThinking(body)) {
    appendWarning(reply, "thinking-disabled-by-bridge");
    return disableThinkingMode(body);
  }

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
        lowConfidenceStrategy: config.lowConfidenceStrategy,
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
      const contextSessions = await store.listByAnchor(anchorKey);
      const bootstrapSessions = bootstrapKey ? await store.listByBootstrapKey(bootstrapKey) : [];

      const explicit = resolveExplicitSessionKey({ body: workingBody, headers: request.headers });
      let resolved = explicit ? {
        ...explicit,
        sessionKey: qualifyKey(downstreamNamespace.namespaceKey, explicit.sessionKey),
        anchorKey: qualifyKey(downstreamNamespace.namespaceKey, explicit.anchorKey)
      } : undefined;
      let resolvedBy: "explicit" | "bootstrap" | "context-key" | "recent-fallback" | "created" = explicit ? "explicit" : "created";

      let bestCandidate =
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
          resolved = {
            sessionKey: recentFallback.sessionKey,
            anchorKey: recentFallback.anchorKey,
            source: recentFallback.source
          };
          resolvedBy = recentFallback.source;
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

      const maybeAdjustedBody = handleLowConfidence(reply, workingBody, bestCandidate);
      if (!maybeAdjustedBody) {
        metrics.recordLowConfidence("reject");
        closeRequest("failure");
        return;
      }
      if (maybeAdjustedBody !== workingBody) {
        metrics.recordLowConfidence("disable-thinking");
      } else if ((bestCandidate?.score ?? 0) > 0) {
        metrics.recordLowConfidence("allowed");
      } else if (isRecentFallbackEligible(workingBody)) {
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
      const repairedBody: ChatCompletionRequest = {
        ...workingBody,
        messages: repairResult.repairedMessages
      };
      const eligibleAssistantMessages = countEligibleAssistantMessages(workingBody.messages);
      const repairedAssistantMessages = repairResult.matches.length;
      const missingAssistantMessages = repairResult.missingAssistantIndexes.length;
      metrics.recordRepair(eligibleAssistantMessages, repairedAssistantMessages, missingAssistantMessages);

      const requestHash = sha256(canonicalJson(buildRequestHashPayload(repairedBody)));
      await store.markInflight(session.sessionKey, {
        requestHash,
        startedAt: Date.now(),
        stream: Boolean(body.stream)
      });

      buildWarningHeaders(repairResult.missingAssistantIndexes, reply);

      request.log.info({
        namespaceKey: downstreamNamespace.namespaceKey,
        sessionKey: session.sessionKey,
        source: resolved.source,
        anchorKey,
        bootstrapKey: bootstrapKey ?? null,
        contextCandidateSessions: contextSessions.length,
        bootstrapCandidateSessions: bootstrapSessions.length,
        bestCandidateScore: bestCandidate?.score ?? 0,
        bestCandidateCount: bestCandidate?.candidateCount ?? 0,
        lowConfidenceStrategy: config.lowConfidenceStrategy,
        stream: Boolean(workingBody.stream),
        matchCount: repairResult.matches.length,
        missingAssistantIndexes: repairResult.missingAssistantIndexes
      }, "request repaired");

      if (config.logBody) {
        request.log.info({
          originalMessages: body.messages,
          repairedMessages: repairedBody.messages
        }, "request body details");
      }

      let upstream: Response;
      try {
        upstream = await forwardToUpstreamWithHeaders(
          repairedBody,
          request.headers,
          request.ip
        );
      } catch (error) {
        await store.clearInflight(session.sessionKey, requestHash);
        const message = error instanceof Error ? error.message : "unknown upstream error";
        const status = message.includes("aborted") ? 504 : 502;
        if (status === 504) {
          metrics.recordUpstreamTimeout();
        }
        closeRequest("failure");
        return reply.code(status).send({
          error: {
            code: "upstream_unavailable",
            message
          }
        });
      }

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
        const errorBody = await upstream.text();
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
          const assistantMessage = finalizeStreamAssistantMessage(assembler);
          if (assistantMessage) {
            await saveAssistantTurn(session.sessionKey, requestHash, assembler.responseId, repairedBody.messages, assistantMessage, store);
          }
          outcome = "success";
        } catch (error) {
          request.log.error({ err: error }, "stream proxy failed");
          metrics.recordStreamInterruption();
        } finally {
          await store.clearInflight(session.sessionKey, requestHash);
          closeRequest(outcome);
        }
        return;
      }

      const rawText = await upstream.text();
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
