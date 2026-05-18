import type {
  AssistantMessageSnapshot,
  ChatCompletionRequest,
  ChatMessage,
  JsonObject,
  StreamAssemblerState,
  ToolCall
} from "../types.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getMessageFromChoice(choice: unknown): ChatMessage | undefined {
  const object = asObject(choice);
  const message = asObject(object?.message);
  if (!message || typeof message.role !== "string") {
    return undefined;
  }
  return message as unknown as ChatMessage;
}

export function extractAssistantMessageFromCompletion(payload: unknown): AssistantMessageSnapshot | undefined {
  const object = asObject(payload);
  const choices = Array.isArray(object?.choices) ? object.choices : [];
  const firstChoice = choices[0];
  const message = getMessageFromChoice(firstChoice);
  if (!message || message.role !== "assistant") {
    return undefined;
  }

  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
    reasoning_content: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined
  };
}

function ensureToolCall(state: StreamAssemblerState, index: number): ToolCall {
  const existing = state.toolCalls.get(index);
  if (existing) {
    return existing;
  }
  const created: ToolCall = { type: "function", function: {} };
  state.toolCalls.set(index, created);
  return created;
}

export function createStreamAssemblerState(): StreamAssemblerState {
  return {
    responseId: undefined,
    contentParts: [],
    reasoningParts: [],
    toolCalls: new Map<number, ToolCall>(),
    finishReason: undefined,
    done: false
  };
}

export function consumeSseEvent(state: StreamAssemblerState, data: string): void {
  if (!data || data === "[DONE]") {
    state.done = true;
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof parsed.id === "string") {
    state.responseId = parsed.id;
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  for (const choice of choices) {
    const choiceObject = asObject(choice);
    if (!choiceObject) {
      continue;
    }
    if (typeof choiceObject.finish_reason === "string") {
      state.finishReason = choiceObject.finish_reason;
    }

    const delta = asObject(choiceObject.delta);
    if (!delta) {
      continue;
    }
    if (typeof delta.content === "string") {
      state.contentParts.push(delta.content);
    }
    if (typeof delta.reasoning_content === "string") {
      state.reasoningParts.push(delta.reasoning_content);
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCall of toolCalls) {
      const toolCallObject = asObject(rawToolCall);
      const index = typeof toolCallObject?.index === "number" ? toolCallObject.index : 0;
      const target = ensureToolCall(state, index);
      if (typeof toolCallObject?.id === "string") {
        target.id = toolCallObject.id;
      }
      if (typeof toolCallObject?.type === "string") {
        target.type = toolCallObject.type;
      }

      const deltaFunction = asObject(toolCallObject?.function);
      if (deltaFunction) {
        target.function = target.function ?? {};
        if (typeof deltaFunction.name === "string") {
          target.function.name = deltaFunction.name;
        }
        if (typeof deltaFunction.arguments === "string") {
          target.function.arguments = (target.function.arguments ?? "") + deltaFunction.arguments;
        }
      }
    }
  }
}

export function finalizeStreamAssistantMessage(state: StreamAssemblerState): AssistantMessageSnapshot | undefined {
  if (!state.contentParts.length && !state.toolCalls.size && !state.reasoningParts.length) {
    return undefined;
  }

  const toolCalls = [...state.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall]) => toolCall);

  return {
    role: "assistant",
    content: state.contentParts.join(""),
    tool_calls: toolCalls.length ? toolCalls : undefined,
    reasoning_content: state.reasoningParts.length ? state.reasoningParts.join("") : undefined
  };
}

export function buildRequestHashPayload(body: ChatCompletionRequest): JsonObject {
  return {
    model: body.model,
    stream: body.stream ?? false,
    reasoning_effort: body.reasoning_effort ?? null,
    messages: body.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id ?? null,
      reasoning_content: message.reasoning_content ?? null
    }))
  };
}
