import type { AssistantMessageSnapshot, MessageFingerprint } from "../types.js";
import { canonicalJson, normalizeText, normalizeToolCalls } from "../utils/canonical.js";
import { sha256 } from "../utils/hash.js";

export function buildMessageFingerprint(message: AssistantMessageSnapshot): MessageFingerprint {
  const content = normalizeText(message.content);
  const strictToolCalls = canonicalJson(normalizeToolCalls(message.tool_calls, true));
  const looseToolCalls = canonicalJson(normalizeToolCalls(message.tool_calls, false));
  const toolShapeOnly = canonicalJson(
    (message.tool_calls ?? []).map((toolCall) => ({
      type: toolCall.type ?? null,
      function: {
        name: toolCall.function?.name ?? null
      }
    }))
  );

  return {
    strict: sha256(JSON.stringify({ content, toolCalls: strictToolCalls })),
    loose: sha256(JSON.stringify({ content, toolCalls: looseToolCalls })),
    contentOnly: sha256(content),
    toolOnly: sha256(looseToolCalls),
    toolShapeOnly: sha256(toolShapeOnly)
  };
}
