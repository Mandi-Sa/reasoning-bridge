import type { JsonValue, ToolCall } from "../types.js";

function normalizeValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  const normalizedEntries = Object.keys(value)
    .sort()
    .map((key) => [key, normalizeValue(value[key])]);
  return Object.fromEntries(normalizedEntries);
}

export function canonicalJson(value: JsonValue | undefined): string {
  return JSON.stringify(normalizeValue(value));
}

export function normalizeText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map((part) => normalizeText(part)).join(" ").replace(/\s+/g, " ").trim();
  }
  if (value && typeof value === "object") {
    return canonicalJson(value);
  }
  return "";
}

export function normalizeToolCalls(toolCalls: ToolCall[] | undefined, keepIds: boolean): JsonValue[] {
  if (!toolCalls?.length) {
    return [];
  }

  return toolCalls.map((toolCall) => ({
    type: toolCall.type ?? null,
    id: keepIds ? toolCall.id ?? null : null,
    function: {
      name: toolCall.function?.name ?? null,
      arguments: toolCall.function?.arguments ?? null
    }
  }));
}
