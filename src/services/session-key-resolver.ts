import type { ChatCompletionRequest, ChatMessage, SessionMatchCandidate, SessionRecord } from "../types.js";
import { canonicalJson, normalizeText } from "../utils/canonical.js";
import { sha256 } from "../utils/hash.js";

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
  ip: string | undefined
): DownstreamNamespace {
  const authorization = readHeader(headers, "authorization");
  const userAgent = readHeader(headers, "user-agent");
  const forwardedFor = readHeader(headers, "x-forwarded-for");
  const realIp = readHeader(headers, "x-real-ip");

  const ipValue = normalizeToken(forwardedFor?.split(",")[0] ?? realIp ?? ip, "unknown-ip");
  const uaValue = normalizeToken(userAgent, "unknown-ua");
  const authHash = authorization ? sha256(authorization) : "no-auth";
  const namespacePayload = {
    authHash,
    ip: ipValue,
    ua: uaValue
  };

  return {
    namespaceKey: `ns:${sha256(canonicalJson(namespacePayload))}`,
    authorizationHash: authHash,
    ipKey: ipValue,
    userAgentKey: uaValue
  };
}

export function resolveExplicitSessionKey(input: SessionResolutionInput): SessionResolutionResult | undefined {
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

  if (typeof bodyAny.user === "string" && bodyAny.user.trim()) {
    const user = bodyAny.user.trim();
    return {
      sessionKey: `user:${user}`,
      anchorKey: `user:${user}`,
      source: "user"
    };
  }

  return undefined;
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

export function scoreSession(body: ChatCompletionRequest, session: SessionRecord): number {
  const incomingAssistants = body.messages.filter((message) => message.role === "assistant");
  const compareCount = Math.min(incomingAssistants.length, session.turns.length, 4);
  if (!compareCount) {
    return 0;
  }

  let score = 0;
  for (let index = 0; index < compareCount; index += 1) {
    const incoming = incomingAssistants[incomingAssistants.length - 1 - index];
    const stored = session.turns[session.turns.length - 1 - index];
    if (!incoming || !stored) {
      continue;
    }
    const incomingContent = normalizeText(incoming.content);
    const storedContent = normalizeText(stored.message.content);
    if (incomingContent && incomingContent === storedContent) {
      score += 2;
    }
    if ((incoming.tool_calls?.length ?? 0) === (stored.message.tool_calls?.length ?? 0)) {
      score += 1;
    }
  }
  return score;
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
    .map((session) => ({
      sessionKey: session.sessionKey,
      anchorKey: session.anchorKey,
      score: scoreSession(input.body, session),
      candidateCount: sessions.length,
      source
    }))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  if (!best || (!allowZeroScore && best.score <= 0)) {
    return undefined;
  }
  return best;
}
