import type { AssistantTurn, ChatMessage, RepairMatch, RepairResult, SessionRecord } from "../types.js";
import { normalizeText } from "../utils/canonical.js";
import { buildMessageFingerprint } from "./fingerprint.js";
import { getStoredTurnFingerprint } from "./stored-turn-fingerprint.js";

interface IncomingAssistantMessage {
  assistantOrder: number;
  messageIndex: number;
  message: ChatMessage;
  fingerprint: ReturnType<typeof buildMessageFingerprint>;
}

interface MatchedTurnCandidate {
  turn: AssistantTurn;
  turnIndex: number;
  strategy: RepairMatch["strategy"];
}

function collectIncomingAssistants(messages: ChatMessage[]): IncomingAssistantMessage[] {
  return messages
    .map((message, messageIndex) => ({
      messageIndex,
      message
    }))
    .filter((item) => item.message.role === "assistant")
    .map((item, assistantOrder) => ({
      assistantOrder,
      messageIndex: item.messageIndex,
      message: item.message,
      fingerprint: buildMessageFingerprint({
        role: "assistant",
        content: item.message.content,
        tool_calls: item.message.tool_calls,
        reasoning_content: undefined
      })
    }));
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

function getSearchWindow(
  incoming: IncomingAssistantMessage[],
  existingMatches: Map<number, MatchedTurnCandidate>,
  assistantOrder: number,
  maxTurnIndex: number
): { start: number; end: number } {
  let start = 0;
  let end = maxTurnIndex;

  for (let index = assistantOrder - 1; index >= 0; index -= 1) {
    const matched = existingMatches.get(incoming[index]?.messageIndex ?? -1);
    if (matched) {
      start = matched.turnIndex + 1;
      break;
    }
  }

  for (let index = assistantOrder + 1; index < incoming.length; index += 1) {
    const matched = existingMatches.get(incoming[index]?.messageIndex ?? -1);
    if (matched) {
      end = matched.turnIndex - 1;
      break;
    }
  }

  return { start, end };
}

function matchFingerprintCandidates(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  existingMatches: Map<number, MatchedTurnCandidate>,
  mode: "strict" | "loose"
): void {
  const usedTurnIds = new Set([...existingMatches.values()].map((item) => item.turn.turnId));

  for (const item of incoming) {
    if (existingMatches.has(item.messageIndex)) {
      continue;
    }

    const { start, end } = getSearchWindow(incoming, existingMatches, item.assistantOrder, storedTurns.length - 1);
    if (start > end) {
      continue;
    }

    for (let turnIndex = start; turnIndex <= end; turnIndex += 1) {
      const turn = storedTurns[turnIndex];
      if (!turn || usedTurnIds.has(turn.turnId)) {
        continue;
      }
      const storedFingerprint = getStoredTurnFingerprint(turn);

      const matched = mode === "strict"
        ? storedFingerprint.strict === item.fingerprint.strict
        : storedFingerprint.loose === item.fingerprint.loose;
      if (!matched) {
        continue;
      }

      existingMatches.set(item.messageIndex, {
        turn,
        turnIndex,
        strategy: mode === "strict" ? "strict-fingerprint" : "loose-fingerprint"
      });
      usedTurnIds.add(turn.turnId);
      break;
    }
  }
}

function matchContentOnlyCandidates(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  existingMatches: Map<number, MatchedTurnCandidate>
): void {
  const usedTurnIds = new Set([...existingMatches.values()].map((item) => item.turn.turnId));

  for (const item of incoming) {
    if (existingMatches.has(item.messageIndex) || !normalizeText(item.message.content)) {
      continue;
    }

    const { start, end } = getSearchWindow(incoming, existingMatches, item.assistantOrder, storedTurns.length - 1);
    if (start > end) {
      continue;
    }

    const candidateTurnIndexes: number[] = [];
    for (let turnIndex = start; turnIndex <= end; turnIndex += 1) {
      const turn = storedTurns[turnIndex];
      if (!turn || usedTurnIds.has(turn.turnId)) {
        continue;
      }
      const storedFingerprint = getStoredTurnFingerprint(turn);
      if (storedFingerprint.contentOnly !== item.fingerprint.contentOnly) {
        continue;
      }
      if (!hasSameToolShape(item.message, turn.message as ChatMessage)) {
        continue;
      }
      candidateTurnIndexes.push(turnIndex);
      if (candidateTurnIndexes.length > 1) {
        break;
      }
    }

    if (candidateTurnIndexes.length !== 1) {
      continue;
    }

    const turnIndex = candidateTurnIndexes[0];
    if (turnIndex === undefined) {
      continue;
    }
    const turn = storedTurns[turnIndex];
    if (!turn) {
      continue;
    }

    existingMatches.set(item.messageIndex, {
      turn,
      turnIndex,
      strategy: "content-only-fingerprint"
    });
    usedTurnIds.add(turn.turnId);
  }
}

function matchToolOnlyCandidates(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  existingMatches: Map<number, MatchedTurnCandidate>
): void {
  const usedTurnIds = new Set([...existingMatches.values()].map((item) => item.turn.turnId));

  for (const item of incoming) {
    if (existingMatches.has(item.messageIndex) || !item.message.tool_calls?.length) {
      continue;
    }

    const { start, end } = getSearchWindow(incoming, existingMatches, item.assistantOrder, storedTurns.length - 1);
    if (start > end) {
      continue;
    }

    const candidateTurnIndexes: number[] = [];
    for (let turnIndex = start; turnIndex <= end; turnIndex += 1) {
      const turn = storedTurns[turnIndex];
      if (!turn || usedTurnIds.has(turn.turnId)) {
        continue;
      }
      const storedFingerprint = getStoredTurnFingerprint(turn);
      if (storedFingerprint.toolOnly !== item.fingerprint.toolOnly) {
        continue;
      }
      candidateTurnIndexes.push(turnIndex);
      if (candidateTurnIndexes.length > 1) {
        break;
      }
    }

    if (candidateTurnIndexes.length !== 1) {
      continue;
    }

    const turnIndex = candidateTurnIndexes[0];
    if (turnIndex === undefined) {
      continue;
    }
    const turn = storedTurns[turnIndex];
    if (!turn) {
      continue;
    }

    existingMatches.set(item.messageIndex, {
      turn,
      turnIndex,
      strategy: "tool-only-fingerprint"
    });
    usedTurnIds.add(turn.turnId);
  }
}

function matchToolShapeOnlyCandidates(
  incoming: IncomingAssistantMessage[],
  storedTurns: AssistantTurn[],
  existingMatches: Map<number, MatchedTurnCandidate>
): void {
  const usedTurnIds = new Set([...existingMatches.values()].map((item) => item.turn.turnId));

  for (const item of incoming) {
    if (existingMatches.has(item.messageIndex) || !item.message.tool_calls?.length) {
      continue;
    }

    const { start, end } = getSearchWindow(incoming, existingMatches, item.assistantOrder, storedTurns.length - 1);
    if (start > end) {
      continue;
    }

    const candidateTurnIndexes: number[] = [];
    for (let turnIndex = start; turnIndex <= end; turnIndex += 1) {
      const turn = storedTurns[turnIndex];
      if (!turn || usedTurnIds.has(turn.turnId)) {
        continue;
      }
      const storedFingerprint = getStoredTurnFingerprint(turn);
      if (storedFingerprint.toolShapeOnly !== item.fingerprint.toolShapeOnly) {
        continue;
      }
      candidateTurnIndexes.push(turnIndex);
      if (candidateTurnIndexes.length > 1) {
        break;
      }
    }

    if (candidateTurnIndexes.length !== 1) {
      continue;
    }

    const turnIndex = candidateTurnIndexes[0];
    if (turnIndex === undefined) {
      continue;
    }
    const turn = storedTurns[turnIndex];
    if (!turn) {
      continue;
    }

    existingMatches.set(item.messageIndex, {
      turn,
      turnIndex,
      strategy: "tool-shape-fingerprint"
    });
    usedTurnIds.add(turn.turnId);
  }
}

export function repairMessages(messages: ChatMessage[], session?: SessionRecord): RepairResult {
  if (!session?.turns.length) {
    return {
      repairedMessages: messages,
      matches: [],
      repairedAssistantIndexes: [],
      missingAssistantIndexes: []
    };
  }

  const incomingAssistants = collectIncomingAssistants(messages);
  if (!incomingAssistants.length) {
    return {
      repairedMessages: messages,
      matches: [],
      repairedAssistantIndexes: [],
      missingAssistantIndexes: []
    };
  }

  const matchedTurns = new Map<number, MatchedTurnCandidate>();
  matchFingerprintCandidates(incomingAssistants, session.turns, matchedTurns, "strict");
  matchFingerprintCandidates(incomingAssistants, session.turns, matchedTurns, "loose");
  matchContentOnlyCandidates(incomingAssistants, session.turns, matchedTurns);
  matchToolOnlyCandidates(incomingAssistants, session.turns, matchedTurns);
  matchToolShapeOnlyCandidates(incomingAssistants, session.turns, matchedTurns);

  const repairedMessages = messages.map((message) => ({ ...message }));
  const matches: RepairMatch[] = [];
  const repairedAssistantIndexes: number[] = [];
  const missingAssistantIndexes: number[] = [];

  for (const item of incomingAssistants) {
    const repairedMessage = repairedMessages[item.messageIndex];
    if (!repairedMessage) {
      continue;
    }

    const matched = matchedTurns.get(item.messageIndex);
    if (!matched) {
      if (!repairedMessage.reasoning_content) {
        missingAssistantIndexes.push(item.messageIndex);
      }
      continue;
    }

    let filledReasoning = false;
    if (!repairedMessage.reasoning_content && matched.turn.message.reasoning_content) {
      repairedMessage.reasoning_content = matched.turn.message.reasoning_content;
      repairedAssistantIndexes.push(item.messageIndex);
      filledReasoning = true;
    }

    matches.push({
      messageIndex: item.messageIndex,
      turnId: matched.turn.turnId,
      strategy: matched.strategy,
      filledReasoning
    });

    if (!repairedMessage.reasoning_content) {
      missingAssistantIndexes.push(item.messageIndex);
    }
  }

  return {
    repairedMessages,
    matches,
    repairedAssistantIndexes,
    missingAssistantIndexes
  };
}
