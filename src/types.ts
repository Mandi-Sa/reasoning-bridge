export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface ToolFunction extends JsonObject {
  name?: string;
  arguments?: string;
}

export interface ToolCall extends JsonObject {
  id?: string;
  type?: string;
  function?: ToolFunction;
}

export interface ChatMessage {
  role: string;
  content?: JsonValue;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  [key: string]: JsonValue | undefined;
}

export interface ChatCompletionRequest extends JsonObject {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  reasoning_effort?: string;
}

export interface AssistantMessageSnapshot {
  role: "assistant";
  content: JsonValue | undefined;
  tool_calls: ToolCall[] | undefined;
  reasoning_content: string | undefined;
}

export interface MessageFingerprint {
  strict: string;
  loose: string;
  contentOnly: string;
  toolOnly: string;
  toolShapeOnly: string;
}

export interface AssistantTurn {
  turnId: string;
  responseId: string | undefined;
  requestHash: string;
  assistantIndex: number;
  historyMessageIndex: number;
  message: AssistantMessageSnapshot;
  fingerprint: MessageFingerprint;
  createdAt: number;
}

export interface InflightRequestRecord {
  requestHash: string;
  startedAt: number;
  stream: boolean;
}

export interface SessionRecord {
  sessionKey: string;
  model: string;
  anchorKey: string;
  bootstrapKey: string | undefined;
  createdAt: number;
  updatedAt: number;
  contextKeys: string[];
  turns: AssistantTurn[];
  requestHashes: string[];
  inflightRequests: InflightRequestRecord[];
}

export interface RepairMatch {
  messageIndex: number;
  turnId: string;
  strategy:
    | "strict-fingerprint"
    | "loose-fingerprint"
    | "content-only-fingerprint"
    | "tool-only-fingerprint"
    | "tool-shape-fingerprint";
  filledReasoning: boolean;
}

export interface RepairResult {
  repairedMessages: ChatMessage[];
  matches: RepairMatch[];
  repairedAssistantIndexes: number[];
  missingAssistantIndexes: number[];
}

export interface SessionMatchCandidate {
  sessionKey: string;
  anchorKey: string;
  score: number;
  secondBestScore: number;
  scoreGap: number;
  matchedTurns: number;
  candidateCount: number;
  source: "bootstrap" | "context-key" | "recent-fallback";
}

export interface UpstreamErrorShape extends JsonObject {
  error?: JsonObject;
}

export interface StreamAssemblerState {
  responseId: string | undefined;
  contentParts: string[];
  reasoningParts: string[];
  toolCalls: Map<number, ToolCall>;
  finishReason: string | undefined;
  done: boolean;
}

export interface StoreStatsSnapshot {
  driver: "memory" | "sqlite" | "redis";
  sessionCount: number;
  estimatedBytes: number | undefined;
  inflightCount: number;
  totalTurns: number;
  sessionsWithBootstrapKey: number;
  recentSessionKeys: string[];
  limits: {
    maxSessions: number;
    maxTurnsPerSession: number;
    maxStoreBytes: number;
  };
  backend: JsonObject;
}
