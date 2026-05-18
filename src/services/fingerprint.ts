import type { AssistantMessageSnapshot, MessageFingerprint } from "../types.js";
import { canonicalJson, normalizeText, normalizeToolCalls } from "../utils/canonical.js";
import { sha256 } from "../utils/hash.js";

export function buildMessageFingerprint(message: AssistantMessageSnapshot): MessageFingerprint {
  const content = normalizeText(message.content);
  const strictToolCalls = canonicalJson(normalizeToolCalls(message.tool_calls, true));
  const looseToolCalls = canonicalJson(normalizeToolCalls(message.tool_calls, false));

  return {
    strict: sha256(JSON.stringify({ content, toolCalls: strictToolCalls })),
    loose: sha256(JSON.stringify({ content, toolCalls: looseToolCalls })),
    contentOnly: sha256(content)
  };
}
