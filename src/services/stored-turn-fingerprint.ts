import type { AssistantTurn } from "../types.js";
import { buildMessageFingerprint } from "./fingerprint.js";

export function getStoredTurnFingerprint(turn: AssistantTurn) {
  return buildMessageFingerprint({
    role: "assistant",
    content: turn.message.content,
    tool_calls: turn.message.tool_calls,
    reasoning_content: undefined
  });
}
