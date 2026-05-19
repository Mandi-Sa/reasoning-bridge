import type { ChatCompletionRequest, ChatMessage, SessionMatchCandidate, SessionRecord } from "../types.js";
import { canonicalJson, normalizeText } from "../utils/canonical.js";
import { sha256 } from "../utils/hash.js";
import { buildMessageFingerprint } from "./fingerprint.js";
import { getStoredTurnFingerprint } from "./stored-turn-fingerprint.js";
import type { BridgeConfig } from "../config.js";

export interface SessionResolutionInput {
  body: ChatCompletionRequest;
  headers: Record<string, string | string[] | undefined>;
}

export interface SessionResolutionResult {
  sessionKey: string;
  anchorKey: string;
  source: "header" | "body" | "user" | "bootstrap" | "context-key" | "recent-fallback";
}

export interface DownstreamNamespace {
  namespaceKey: string;
  authorizationHash: string;
  ipKey: string;
  userAgentKey: string;
}

interface SessionScoreResult {
  score: number;
  matchedTurns: number;
}

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function normalizeToken(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return value.replace(/\s+/g, " ").trim().toLowerCase() || fallback;
}

export function buildDownstreamNamespace(
  headers: Record<string, string | string[] | undefined>,
  ip: string | undefined,
  options: Pick<BridgeConfig, "namespaceIncludeAuthorization" | "namespaceIncludeUserAgent" | "namespaceIncludeIp">
): DownstreamNamespace {
  const authorization = readHeader(headers, "authorization");
  const userAgent = readHeader(headers, "user-agent");
  const forwardedFor = readHeader(headers, "x-forwarded-for");
  const realIp = readHeader(headers, "x-real-ip");

  const ipValue = normalizeToken(forwardedFor?.split(",")[0] ?? realIp ?? ip, "unknown-ip");
  const uaValue = normalizeToken(userAgent, "unknown-ua");
  const authHash = authorization ? sha256(authorization) : "no-auth";
  const namespacePayload: Record<string, string> = {};
  if (options.namespaceIncludeAuthorization) {
    namespacePayload.authHash = authHash;
  }
  if (options.namespaceIncludeUserAgent) {
    namespacePayload.ua = uaValue;
  }
  if (options.namespaceIncludeIp) {
    namespacePayload.ip = ipValue;
  }
  if (!Object.keys(namespacePayload).length) {
    namespacePayload.authHash = authHash;
  }

  return {
    namespaceKey: `ns:${sha256(canonicalJson(namespacePayload))}`,
    authorizationHash: authHash,
    ipKey: ipValue,
    userAgentKey: uaValue
  };
}

export function resolveExplicitSessionKey(
  input: SessionResolutionInput,
  options?: { allowUserScopedSessions?: boolean }
): SessionResolutionResult | undefined {
  const headerValue =
    readHeader(input.headers, "x-session-id") ??
    readHeader(input.headers, "x-conversation-id") ??
    readHeader(input.headers, "x-bridge-session-id");
  if (headerValue) {
    return {
      sessionKey: `explicit:${headerValue}`,
      anchorKey: `explicit:${headerValue}`,
      source: "header"
    };
  }

  const bodyAny = input.body as Record<string, unknown>;
  const sessionId =
    typeof bodyAny.session_id === "string" ? bodyAny.session_id :
    typeof bodyAny.conversation_id === "string" ? bodyAny.conversation_id :
    undefined;
  if (sessionId) {
    return {
      sessionKey: `body:${sessionId}`,
      anchorKey: `body:${sessionId}`,
      source: "body"
    };
  }

  const metadata = bodyAny.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const metaSessionId = typeof (metadata as Record<string, unknown>).session_id === "string"
      ? (metadata as Record<string, string>).session_id
      : undefined;
    if (metaSessionId) {
      return {
        sessionKey: `body:${metaSessionId}`,
        anchorKey: `body:${metaSessionId}`,
        source: "body"
      };
    }
  }

  if (options?.allowUserScopedSessions && typeof bodyAny.user === "string" && bodyAny.user.trim()) {
    const user = bodyAny.user.trim();
    return {
      sessionKey: `user:${user}`,
      anchorKey: `user:${user}`,
      source: "user"
    };
  }

  return undefined;
}

function buildAssistantFingerprint(message: ChatMessage) {
  return buildMessageFingerprint({
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
    reasoning_content: undefined
  });
}

function getToolCallNames(message: ChatMessage): string[] {
  return message.tool_calls?.map((toolCall) => toolCall.function?.name ?? "") ?? [];
}

function hasSameToolShape(left: ChatMessage, right: ChatMessage): boolean {
  const leftNames = getToolCallNames(left);
  const rightNames = getToolCallNames(right);
  if (leftNames.length !== rightNames.length) {
    return false;
  }
  return leftNames.every((name, index) => name === rightNames[index]);
}

function summarizeMessage(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: normalizeText(message.content),
    tool_calls: message.tool_calls?.map((toolCall) => ({
      id: toolCall.id ?? null,
      type: toolCall.type ?? null,
      name: toolCall.function?.name ?? null,
      arguments: toolCall.function?.arguments ?? null
    })) ?? []
  });
}

function buildConversationPrefix(body: ChatCompletionRequest): string {
  const prefixMessages: string[] = [];

  for (const message of body.messages) {
    if (message.role === "assistant") {
      break;
    }
    prefixMessages.push(summarizeMessage(message));
  }

  if (!prefixMessages.length) {
    const firstUser = body.messages.find((message) => message.role === "user");
    return firstUser ? summarizeMessage(firstUser) : JSON.stringify({ model: body.model, empty: true });
  }

  return JSON.stringify({
    model: body.model,
    prefixMessages
  });
}

export function buildAnchorKey(body: ChatCompletionRequest): string {
  return `anchor:${sha256(buildConversationPrefix(body))}`;
}

export function buildBootstrapKey(body: ChatCompletionRequest): string | undefined {
  const selectedMessages: string[] = [];
  let firstUserCaptured = false;

  for (const message of body.messages) {
    if (message.role === "assistant") {
      break;
    }
    if (message.role === "system") {
      selectedMessages.push(summarizeMessage(message));
      continue;
    }
    if (message.role === "user" && !firstUserCaptured) {
      selectedMessages.push(summarizeMessage(message));
      firstUserCaptured = true;
      continue;
    }
  }

  if (!selectedMessages.length) {
    return undefined;
  }

  return `bootstrap:${sha256(JSON.stringify({
    model: body.model,
    selectedMessages
  }))}`;
}

function scoreSession(body: ChatCompletionRequest, session: SessionRecord): SessionScoreResult {
  const incomingAssistants = body.messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      message,
      fingerprint: buildAssistantFingerprint(message)
    }));
  const compareCount = Math.min(incomingAssistants.length, session.turns.length, 6);
  let score = body.model === session.model ? 1 : 0;
  let matchedTurns = 0;

  for (let index = 0; index < compareCount; index += 1) {
    const incoming = incomingAssistants[incomingAssistants.length - 1 - index];
    const stored = session.turns[session.turns.length - 1 - index];
    if (!incoming || !stored) {
      continue;
    }
    const storedFingerprint = getStoredTurnFingerprint(stored);

    if (storedFingerprint.strict === incoming.fingerprint.strict) {
      score += 8;
      matchedTurns += 1;
      continue;
    }
    if (storedFingerprint.loose === incoming.fingerprint.loose) {
      score += 6;
      matchedTurns += 1;
      continue;
    }
    if (storedFingerprint.contentOnly === incoming.fingerprint.contentOnly) {
      score += hasSameToolShape(incoming.message, stored.message as ChatMessage) ? 4 : 3;
      matchedTurns += 1;
      continue;
    }
    if (storedFingerprint.toolOnly === incoming.fingerprint.toolOnly) {
      score += 5;
      matchedTurns += 1;
      continue;
    }
    if (storedFingerprint.toolShapeOnly === incoming.fingerprint.toolShapeOnly) {
      score += 3;
      matchedTurns += 1;
      continue;
    }

    const incomingContent = normalizeText(incoming.message.content);
    const storedContent = normalizeText(stored.message.content);
    if (incomingContent && incomingContent === storedContent && hasSameToolShape(incoming.message, stored.message as ChatMessage)) {
      score += 2;
      matchedTurns += 1;
    }
  }

  return {
    score: score + matchedTurns,
    matchedTurns
  };
}

export function findBestSessionCandidate(
  input: SessionResolutionInput,
  sessions: SessionRecord[],
  source: "bootstrap" | "context-key" | "recent-fallback",
  allowZeroScore = false
): SessionMatchCandidate | undefined {
  if (!sessions.length) {
    return undefined;
  }

  const ranked = [...sessions]
    .map((session) => {
      const scored = scoreSession(input.body, session);
      return {
      sessionKey: session.sessionKey,
      anchorKey: session.anchorKey,
      score: scored.score,
      matchedTurns: scored.matchedTurns,
      candidateCount: sessions.length,
      source,
      updatedAt: session.updatedAt
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedTurns - left.matchedTurns ||
      right.updatedAt - left.updatedAt
    );

  const best = ranked[0];
  if (!best || (!allowZeroScore && best.score <= 0)) {
    return undefined;
  }
  const secondBestScore = ranked[1]?.score ?? 0;
  return {
    sessionKey: best.sessionKey,
    anchorKey: best.anchorKey,
    score: best.score,
    secondBestScore,
    scoreGap: best.score - secondBestScore,
    matchedTurns: best.matchedTurns,
    candidateCount: best.candidateCount,
    source: best.source
  };
}
