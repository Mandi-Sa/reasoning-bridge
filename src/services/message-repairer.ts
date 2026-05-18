import type { AssistantTurn, ChatMessage, RepairMatch, RepairResult, SessionRecord } from "../types.js";
import { buildMessageFingerprint } from "./fingerprint.js";

interface IncomingAssistantMessage {
  messageIndex: number;
  message: ChatMessage;
}

function collectIncomingAssistants(messages: ChatMessage[]): IncomingAssistantMessage[] {
  return messages
    .map((message, messageIndex) => ({ messageIndex, message }))
    .filter((item) => item.message.role === "assistant");
}

function matchExactCandidates(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  mode: "strict" | "loose"
): Map<number, { turn: AssistantTurn; strategy: RepairMatch["strategy"] }> {
  const result = new Map<number, { turn: AssistantTurn; strategy: RepairMatch["strategy"] }>();
  const usedTurnIds = new Set<string>();
  let cursor = 0;

  for (const item of incoming) {
    const fingerprint = buildMessageFingerprint({
      role: "assistant",
      content: item.message.content,
      tool_calls: item.message.tool_calls,
      reasoning_content: undefined
    });

    for (let turnIndex = cursor; turnIndex < storedTurns.length; turnIndex += 1) {
      const turn = storedTurns[turnIndex];
      if (!turn) {
        continue;
      }
      if (usedTurnIds.has(turn.turnId)) {
        continue;
      }
      const matched = mode === "strict"
        ? turn.fingerprint.strict === fingerprint.strict
        : turn.fingerprint.loose === fingerprint.loose;
      if (!matched) {
        continue;
      }
      result.set(item.messageIndex, {
        turn,
        strategy: mode === "strict" ? "strict-fingerprint" : "loose-fingerprint"
      });
      usedTurnIds.add(turn.turnId);
      cursor = turnIndex + 1;
      break;
    }
  }

  return result;
}

function matchOrderedFallback(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  existingMatches: Map<number, { turn: AssistantTurn; strategy: RepairMatch["strategy"] }>
): Map<number, { turn: AssistantTurn; strategy: RepairMatch["strategy"] }> {
  const usedTurnIds = new Set([...existingMatches.values()].map((item) => item.turn.turnId));
  const unmatchedIncoming = incoming.filter((item) => !existingMatches.has(item.messageIndex));
  if (!unmatchedIncoming.length) {
    return existingMatches;
  }

  const remainingTurns = storedTurns.filter((turn) => !usedTurnIds.has(turn.turnId));
  if (!remainingTurns.length) {
    return existingMatches;
  }

  const startOffset = Math.max(0, remainingTurns.length - unmatchedIncoming.length);
  unmatchedIncoming.forEach((item, index) => {
    const turn = remainingTurns[startOffset + index];
    if (!turn) {
      return;
    }
    existingMatches.set(item.messageIndex, { turn, strategy: "ordered-fallback" });
  });
  return existingMatches;
}

export function repairMessages(messages: ChatMessage[], session?: SessionRecord): RepairResult {
  if (!session?.turns.length) {
    return {
      repairedMessages: messages,
      matches: [],
      missingAssistantIndexes: []
    };
  }

  const incomingAssistants = collectIncomingAssistants(messages);
  if (!incomingAssistants.length) {
    return {
      repairedMessages: messages,
      matches: [],
      missingAssistantIndexes: []
    };
  }

  const strictMatches = matchExactCandidates(incomingAssistants, session.turns, "strict");
  const afterLoose = matchOrderedFallback(
    incomingAssistants,
    session.turns,
    new Map([
      ...strictMatches,
      ...matchExactCandidates(
        incomingAssistants.filter((item) => !strictMatches.has(item.messageIndex)),
        session.turns.filter((turn) => ![...strictMatches.values()].some((matched) => matched.turn.turnId === turn.turnId)),
        "loose"
      )
    ])
  );

  const repairedMessages = messages.map((message) => ({ ...message }));
  const matches: RepairMatch[] = [];
  const missingAssistantIndexes: number[] = [];

  for (const item of incomingAssistants) {
    const matched = afterLoose.get(item.messageIndex);
    if (!matched) {
      if (!item.message.reasoning_content) {
        missingAssistantIndexes.push(item.messageIndex);
      }
      continue;
    }

    const repairedMessage = repairedMessages[item.messageIndex];
    if (!repairedMessage) {
      continue;
    }

    if (!repairedMessage.reasoning_content && matched.turn.message.reasoning_content) {
      repairedMessage.reasoning_content = matched.turn.message.reasoning_content;
    }
    matches.push({
      messageIndex: item.messageIndex,
      turnId: matched.turn.turnId,
      strategy: matched.strategy
    });
  }

  return {
    repairedMessages,
    matches,
    missingAssistantIndexes
  };
}
