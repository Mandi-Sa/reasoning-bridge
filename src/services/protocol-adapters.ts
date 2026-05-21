import type {
  AssistantMessageSnapshot,
  ChatCompletionRequest,
  ChatMessage,
  JsonObject,
  JsonValue,
  ProtocolStreamAssemblerState,
  RepairResult,
  SessionRecord,
  ToolCall
} from "../types.js";
import { canonicalJson } from "../utils/canonical.js";
import { repairMessages } from "./message-repairer.js";

interface IndexedReasoningBlock extends JsonObject {
  index: number;
  block: JsonValue;
}

interface ProtocolRepairResult<TBody extends JsonObject> {
  internalBody: ChatCompletionRequest;
  repairedBody: TBody;
  repairResult: RepairResult;
}

interface ResponsesAssistantGroup {
  messageIndex: number;
  itemIndexes: number[];
}

interface ResponsesInternalProjection {
  internalBody: ChatCompletionRequest;
  groups: ResponsesAssistantGroup[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function cloneJson<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined) {
    return undefined as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function arrayContent(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function blockType(value: JsonValue | undefined): string | undefined {
  const object = asObject(value);
  return typeof object?.type === "string" ? object.type : undefined;
}

function isReasoningBlock(value: JsonValue | undefined): boolean {
  const type = blockType(value);
  return type === "thinking" || type === "reasoning";
}

function encodeReasoningBlocks(blocks: IndexedReasoningBlock[]): string | undefined {
  return blocks.length ? canonicalJson(blocks) : undefined;
}

function decodeReasoningBlocks(value: JsonValue[] | undefined, fallback: string | undefined): IndexedReasoningBlock[] {
  if (value?.length) {
    return value
      .map((item, fallbackIndex) => {
        const object = asObject(item);
        const index = typeof object?.index === "number" ? object.index : fallbackIndex;
        const block = object && "block" in object ? object.block as JsonValue : item;
        return { index, block };
      })
      .filter((item) => item.block !== undefined);
  }

  if (!fallback) {
    return [];
  }

  try {
    const parsed = JSON.parse(fallback) as JsonValue;
    return arrayContent(parsed)
      .map((item, fallbackIndex) => {
        const object = asObject(item);
        const index = typeof object?.index === "number" ? object.index : fallbackIndex;
        const block = object && "block" in object ? object.block as JsonValue : item;
        return { index, block };
      })
      .filter((item) => item.block !== undefined);
  } catch {
    return [];
  }
}

function toAnthropicToolCall(block: JsonValue): ToolCall | undefined {
  const object = asObject(block);
  if (!object || object.type !== "tool_use" || typeof object.name !== "string") {
    return undefined;
  }
  const toolCall: ToolCall = {
    type: "function",
    function: {
      name: object.name,
      arguments: JSON.stringify(object.input ?? {})
    }
  };
  if (typeof object.id === "string") {
    toolCall.id = object.id;
  }
  return toolCall;
}

function fromAnthropicAssistantMessage(message: ChatMessage): ChatMessage {
  const blocks = arrayContent(message.content);
  const reasoningBlocks: IndexedReasoningBlock[] = [];
  const visibleBlocks: JsonValue[] = [];
  const toolCalls: ToolCall[] = [];

  blocks.forEach((block, index) => {
    if (isReasoningBlock(block)) {
      reasoningBlocks.push({ index, block });
      return;
    }
    visibleBlocks.push(block);
    const toolCall = toAnthropicToolCall(block);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  });

  const nextMessage: ChatMessage = {
    ...message,
    content: visibleBlocks
  };
  if (toolCalls.length) {
    nextMessage.tool_calls = toolCalls;
  } else {
    delete nextMessage.tool_calls;
  }
  const reasoningContent = encodeReasoningBlocks(reasoningBlocks);
  if (reasoningContent) {
    nextMessage.reasoning_content = reasoningContent;
  } else {
    delete nextMessage.reasoning_content;
  }
  return nextMessage;
}

export function anthropicMessagesToInternalRequest(body: JsonObject): ChatCompletionRequest {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const request: ChatCompletionRequest = {
    ...body,
    model: typeof body.model === "string" ? body.model : "",
    messages: messages
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => {
        const message = item as unknown as ChatMessage;
        return message.role === "assistant" ? fromAnthropicAssistantMessage(message) : message;
      })
  };
  if (typeof body.stream === "boolean") {
    request.stream = body.stream;
  }
  return request;
}

export function extractAssistantFromAnthropicMessage(payload: unknown): AssistantMessageSnapshot | undefined {
  const object = asObject(payload);
  if (!object || object.role !== "assistant") {
    return undefined;
  }

  const blocks = arrayContent(object.content as JsonValue | undefined);
  const reasoningBlocks: IndexedReasoningBlock[] = [];
  const visibleBlocks: JsonValue[] = [];
  const toolCalls: ToolCall[] = [];

  blocks.forEach((block, index) => {
    if (isReasoningBlock(block)) {
      reasoningBlocks.push({ index, block });
      return;
    }
    visibleBlocks.push(block);
    const toolCall = toAnthropicToolCall(block);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  });

  const assistant: AssistantMessageSnapshot = {
    role: "assistant",
    content: visibleBlocks,
    tool_calls: undefined,
    reasoning_content: encodeReasoningBlocks(reasoningBlocks)
  };
  if (toolCalls.length) {
    assistant.tool_calls = toolCalls;
  }
  if (reasoningBlocks.length) {
    assistant.reasoning_blocks = reasoningBlocks;
  }
  return assistant;
}

export function repairAnthropicMessages(body: JsonObject, session?: SessionRecord): ProtocolRepairResult<JsonObject> {
  const internalBody = anthropicMessagesToInternalRequest(body);
  const repairResult = repairMessages(internalBody.messages, session);
  const repairedMessages = arrayContent(body.messages as JsonValue | undefined)
    .map((message) => cloneJson(message) as JsonObject);
  const turnsById = new Map((session?.turns ?? []).map((turn) => [turn.turnId, turn]));

  for (const match of repairResult.matches) {
    if (!match.filledReasoning) {
      continue;
    }
    const turn = turnsById.get(match.turnId);
    const message = repairedMessages[match.messageIndex];
    if (!turn || !message) {
      continue;
    }
    const blocks = decodeReasoningBlocks(turn.message.reasoning_blocks, turn.message.reasoning_content);
    if (!blocks.length) {
      continue;
    }
    const content = arrayContent(message.content as JsonValue | undefined);
    const hasReasoning = content.some((block) => isReasoningBlock(block));
    if (hasReasoning) {
      continue;
    }
    const nextContent = [...content];
    for (const item of blocks.sort((left, right) => left.index - right.index)) {
      nextContent.splice(Math.min(item.index, nextContent.length), 0, cloneJson(item.block));
    }
    message.content = nextContent;
  }

  const repairedBody = {
    ...body,
    messages: repairedMessages
  };
  const repairedInternalBody = anthropicMessagesToInternalRequest(repairedBody);

  return {
    internalBody: repairedInternalBody,
    repairedBody,
    repairResult: {
      ...repairResult,
      repairedMessages: repairedInternalBody.messages,
      missingAssistantIndexes: repairedInternalBody.messages
        .map((message, index) => ({ message, index }))
        .filter((item) => item.message.role === "assistant" && !item.message.reasoning_content)
        .map((item) => item.index)
    }
  };
}

function toResponsesToolCall(item: JsonValue): ToolCall | undefined {
  const object = asObject(item);
  if (!object || object.type !== "function_call") {
    return undefined;
  }
  const toolCall: ToolCall = {
    type: "function",
    function: {
      arguments: typeof object.arguments === "string" ? object.arguments : JSON.stringify(object.arguments ?? {})
    }
  };
  if (typeof object.call_id === "string") {
    toolCall.id = object.call_id;
  } else if (typeof object.id === "string") {
    toolCall.id = object.id;
  }
  if (typeof object.name === "string") {
    toolCall.function = {
      ...toolCall.function,
      name: object.name
    };
  }
  return toolCall;
}

function isResponsesAssistantItem(value: JsonValue | undefined): boolean {
  const object = asObject(value);
  if (!object) {
    return false;
  }
  if (object.type === "function_call" || object.type === "reasoning") {
    return true;
  }
  return object.type === "message" && object.role === "assistant";
}

function isResponsesReasoningItem(value: JsonValue | undefined): boolean {
  return blockType(value) === "reasoning";
}

function buildResponsesProjection(body: JsonObject): ResponsesInternalProjection {
  const messages: ChatMessage[] = [];
  const groups: ResponsesAssistantGroup[] = [];
  const input = body.input;

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    let currentItems: JsonValue[] = [];
    let currentIndexes: number[] = [];

    const flushAssistantGroup = (): void => {
      if (!currentItems.length) {
        return;
      }
      const reasoningBlocks: IndexedReasoningBlock[] = [];
      const visibleItems: JsonValue[] = [];
      const toolCalls: ToolCall[] = [];
      currentItems.forEach((item, groupIndex) => {
        if (isResponsesReasoningItem(item)) {
          reasoningBlocks.push({ index: groupIndex, block: item });
          return;
        }
        visibleItems.push(item);
        const toolCall = toResponsesToolCall(item);
        if (toolCall) {
          toolCalls.push(toolCall);
        }
      });
      const messageIndex = messages.length;
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: visibleItems
      };
      if (toolCalls.length) {
        assistantMessage.tool_calls = toolCalls;
      }
      const reasoningContent = encodeReasoningBlocks(reasoningBlocks);
      if (reasoningContent) {
        assistantMessage.reasoning_content = reasoningContent;
      }
      messages.push(assistantMessage);
      groups.push({
        messageIndex,
        itemIndexes: currentIndexes
      });
      currentItems = [];
      currentIndexes = [];
    };

    input.forEach((item, itemIndex) => {
      const jsonItem = item as JsonValue;
      if (isResponsesAssistantItem(jsonItem)) {
        currentItems.push(jsonItem);
        currentIndexes.push(itemIndex);
        return;
      }
      flushAssistantGroup();
      const object = asObject(jsonItem);
      if (object && typeof object.role === "string") {
        const message: ChatMessage = { role: object.role };
        if (object.content !== undefined) {
          message.content = object.content as JsonValue;
        }
        messages.push(message);
      } else {
        messages.push({ role: "user", content: jsonItem });
      }
    });
    flushAssistantGroup();
  }

  const internalBody: ChatCompletionRequest = {
    ...body,
    model: typeof body.model === "string" ? body.model : "",
    messages
  };
  if (typeof body.stream === "boolean") {
    internalBody.stream = body.stream;
  }

  return {
    internalBody,
    groups
  };
}

export function responsesToInternalRequest(body: JsonObject): ChatCompletionRequest {
  return buildResponsesProjection(body).internalBody;
}

export function extractAssistantFromResponses(payload: unknown): AssistantMessageSnapshot | undefined {
  const object = asObject(payload);
  const output = Array.isArray(object?.output) ? object.output as JsonValue[] : [];
  if (!output.length) {
    return undefined;
  }

  const reasoningBlocks: IndexedReasoningBlock[] = [];
  const visibleItems: JsonValue[] = [];
  const toolCalls: ToolCall[] = [];
  output.forEach((item, index) => {
    if (isResponsesReasoningItem(item)) {
      reasoningBlocks.push({ index, block: item });
      return;
    }
    visibleItems.push(item);
    const toolCall = toResponsesToolCall(item);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  });

  const assistant: AssistantMessageSnapshot = {
    role: "assistant",
    content: visibleItems,
    tool_calls: undefined,
    reasoning_content: encodeReasoningBlocks(reasoningBlocks)
  };
  if (toolCalls.length) {
    assistant.tool_calls = toolCalls;
  }
  if (reasoningBlocks.length) {
    assistant.reasoning_blocks = reasoningBlocks;
  }
  return assistant;
}

export function repairResponsesInput(body: JsonObject, session?: SessionRecord): ProtocolRepairResult<JsonObject> {
  const projection = buildResponsesProjection(body);
  const repairResult = repairMessages(projection.internalBody.messages, session);
  const turnsById = new Map((session?.turns ?? []).map((turn) => [turn.turnId, turn]));
  const input = Array.isArray(body.input) ? [...body.input.map((item) => cloneJson(item as JsonValue))] : body.input;

  if (Array.isArray(input)) {
    const insertions: Array<{ index: number; blocks: JsonValue[] }> = [];
    for (const match of repairResult.matches) {
      if (!match.filledReasoning) {
        continue;
      }
      const group = projection.groups.find((item) => item.messageIndex === match.messageIndex);
      const turn = turnsById.get(match.turnId);
      if (!group || !turn) {
        continue;
      }
      const hasReasoning = group.itemIndexes.some((itemIndex) => isResponsesReasoningItem(input[itemIndex] as JsonValue | undefined));
      if (hasReasoning) {
        continue;
      }
      const blocks = decodeReasoningBlocks(turn.message.reasoning_blocks, turn.message.reasoning_content);
      if (!blocks.length) {
        continue;
      }
      insertions.push({
        index: group.itemIndexes[0] ?? input.length,
        blocks: blocks.sort((left, right) => left.index - right.index).map((item) => cloneJson(item.block))
      });
    }

    let offset = 0;
    for (const insertion of insertions.sort((left, right) => left.index - right.index)) {
      input.splice(insertion.index + offset, 0, ...insertion.blocks);
      offset += insertion.blocks.length;
    }
  }

  const repairedBody = {
    ...body,
    input
  };
  const repairedProjection = buildResponsesProjection(repairedBody);

  return {
    internalBody: repairedProjection.internalBody,
    repairedBody,
    repairResult: {
      ...repairResult,
      repairedMessages: repairedProjection.internalBody.messages,
      missingAssistantIndexes: repairedProjection.internalBody.messages
        .map((message, index) => ({ message, index }))
        .filter((item) => item.message.role === "assistant" && !item.message.reasoning_content)
        .map((item) => item.index)
    }
  };
}

export function createProtocolStreamAssemblerState(): ProtocolStreamAssemblerState {
  return {
    responseId: undefined,
    assistantMessage: undefined,
    anthropicBlocks: new Map<number, JsonObject>(),
    anthropicJsonDeltas: new Map<number, string>(),
    responsesItems: new Map<number, JsonObject>(),
    done: false
  };
}

function setAnthropicBlockText(block: JsonObject, key: "text" | "thinking" | "signature", value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  block[key] = `${typeof block[key] === "string" ? block[key] : ""}${value}`;
}

function finalizeAnthropicAssistantFromBlocks(state: ProtocolStreamAssemblerState): void {
  const content = [...state.anthropicBlocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, block]) => {
      const nextBlock = cloneJson(block) as JsonObject;
      const partialJson = state.anthropicJsonDeltas.get(index);
      if (partialJson) {
        try {
          nextBlock.input = JSON.parse(partialJson) as JsonValue;
        } catch {
          nextBlock.input = partialJson;
        }
      }
      return nextBlock as JsonValue;
    });
  if (content.length) {
    state.assistantMessage = extractAssistantFromAnthropicMessage({
      role: "assistant",
      content
    });
  }
}

export function consumeAnthropicSseEvent(state: ProtocolStreamAssemblerState, data: string): void {
  if (!data || data === "[DONE]") {
    state.done = true;
    finalizeAnthropicAssistantFromBlocks(state);
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.type === "message_start") {
    const message = asObject(parsed.message);
    if (typeof message?.id === "string") {
      state.responseId = message.id;
    }
  }
  if (parsed.type === "content_block_start") {
    const index = typeof parsed.index === "number" ? parsed.index : 0;
    const contentBlock = asObject(parsed.content_block);
    if (contentBlock) {
      state.anthropicBlocks.set(index, cloneJson(contentBlock as JsonObject) as JsonObject);
    }
  }
  if (parsed.type === "content_block_delta") {
    const index = typeof parsed.index === "number" ? parsed.index : 0;
    const delta = asObject(parsed.delta);
    const block = state.anthropicBlocks.get(index) ?? {};
    state.anthropicBlocks.set(index, block);
    if (delta?.type === "text_delta") {
      setAnthropicBlockText(block, "text", delta.text);
    }
    if (delta?.type === "thinking_delta") {
      setAnthropicBlockText(block, "thinking", delta.thinking);
    }
    if (delta?.type === "signature_delta") {
      setAnthropicBlockText(block, "signature", delta.signature);
    }
    if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      state.anthropicJsonDeltas.set(index, `${state.anthropicJsonDeltas.get(index) ?? ""}${delta.partial_json}`);
    }
  }
  if (parsed.type === "content_block_stop") {
    finalizeAnthropicAssistantFromBlocks(state);
  }
  if (parsed.type === "message_stop") {
    state.done = true;
    finalizeAnthropicAssistantFromBlocks(state);
  }
  if (parsed.type === "message_delta" && typeof asObject(parsed.delta)?.stop_reason === "string") {
    state.done = true;
  }
  if (parsed.type === "message_start" && asObject(parsed.message)?.role === "assistant") {
    state.assistantMessage = extractAssistantFromAnthropicMessage(parsed.message);
  }
}

function finalizeResponsesAssistantFromItems(state: ProtocolStreamAssemblerState): void {
  const output = [...state.responsesItems.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, item]) => cloneJson(item) as JsonValue);
  if (output.length) {
    state.assistantMessage = extractAssistantFromResponses({ output });
  }
}

export function consumeResponsesSseEvent(state: ProtocolStreamAssemblerState, data: string): void {
  if (!data || data === "[DONE]") {
    state.done = true;
    finalizeResponsesAssistantFromItems(state);
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof parsed.response_id === "string") {
    state.responseId = parsed.response_id;
  }
  const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : undefined;
  const item = asObject(parsed.item);
  if (outputIndex !== undefined && item) {
    state.responsesItems.set(outputIndex, cloneJson(item as JsonObject) as JsonObject);
    finalizeResponsesAssistantFromItems(state);
  }
  const response = asObject(parsed.response);
  if (response) {
    if (typeof response.id === "string") {
      state.responseId = response.id;
    }
    const assistant = extractAssistantFromResponses(response);
    if (assistant) {
      state.assistantMessage = assistant;
    }
  }
  if (parsed.type === "response.completed" || parsed.type === "response.failed" || parsed.type === "response.incomplete") {
    state.done = true;
    finalizeResponsesAssistantFromItems(state);
  }
}
