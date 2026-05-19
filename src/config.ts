import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BridgeConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamPath: string;
  requestTimeoutMs: number;
  cleanupIntervalMs: number;
  logBody: boolean;
  recentFallbackLimit: number;
  recentFallbackMinScore: number;
  sessionMatchMinScore: number;
  sessionMatchMinMargin: number;
  lowConfidenceStrategy: "warn" | "disable-thinking" | "reject";
  forceInjectReasoningEffortNone: boolean;
  namespaceIncludeAuthorization: boolean;
  namespaceIncludeUserAgent: boolean;
  namespaceIncludeIp: boolean;
  allowUserScopedSessions: boolean;
  sessionStoreDriver: "memory" | "sqlite" | "redis";
  sessionStoreFilePath: string;
  redisUrl: string | undefined;
  redisKeyPrefix: string;
  maxSessions: number;
  maxTurnsPerSession: number;
  maxStoreBytes: number;
}

interface BridgeConfigFileShape {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamPath?: string;
  requestTimeoutMs?: number;
  cleanupIntervalMs?: number;
  logBody?: boolean;
  recentFallbackLimit?: number;
  recentFallbackMinScore?: number;
  sessionMatchMinScore?: number;
  sessionMatchMinMargin?: number;
  lowConfidenceStrategy?: "warn" | "disable-thinking" | "reject";
  forceInjectReasoningEffortNone?: boolean;
  namespaceIncludeAuthorization?: boolean;
  namespaceIncludeUserAgent?: boolean;
  namespaceIncludeIp?: boolean;
  allowUserScopedSessions?: boolean;
  sessionStoreDriver?: "memory" | "sqlite" | "redis";
  sessionStoreFilePath?: string;
  redisUrl?: string;
  redisKeyPrefix?: string;
  maxSessions?: number;
  maxTurnsPerSession?: number;
  maxStoreBytes?: number;
}

function readNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric config ${name}: ${value}`);
  }
  return parsed;
}

function readLowConfidenceStrategy(value: string | undefined): "warn" | "disable-thinking" | "reject" {
  const raw = (value ?? "warn").toLowerCase();
  if (raw === "warn" || raw === "disable-thinking" || raw === "reject") {
    return raw;
  }
  throw new Error(`Invalid lowConfidenceStrategy: ${raw}`);
}

function loadConfigFile(): BridgeConfigFileShape {
  const configPath = resolve(process.cwd(), process.env.BRIDGE_CONFIG_PATH ?? "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file at ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file at ${configPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file at ${configPath} must contain a JSON object`);
  }

  return parsed as BridgeConfigFileShape;
}

export function loadConfig(): BridgeConfig {
  const fileConfig = loadConfigFile();
  const upstreamBaseUrl = fileConfig.upstreamBaseUrl;
  const upstreamApiKey = fileConfig.upstreamApiKey;
  if (!upstreamBaseUrl) {
    throw new Error("upstreamBaseUrl is required in config.json");
  }
  if (!upstreamApiKey) {
    throw new Error("upstreamApiKey is required in config.json");
  }

  const sessionStoreDriver = fileConfig.sessionStoreDriver ?? "memory";
  if (sessionStoreDriver !== "memory" && sessionStoreDriver !== "sqlite" && sessionStoreDriver !== "redis") {
    throw new Error(`Invalid sessionStoreDriver: ${sessionStoreDriver}`);
  }
  if (sessionStoreDriver === "redis" && !fileConfig.redisUrl) {
    throw new Error("redisUrl is required when sessionStoreDriver is redis");
  }

  return {
    host: fileConfig.host ?? "0.0.0.0",
    port: readNumber(fileConfig.port, 8787, "port"),
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ""),
    upstreamApiKey,
    upstreamPath: fileConfig.upstreamPath ?? "/v1/chat/completions",
    requestTimeoutMs: readNumber(fileConfig.requestTimeoutMs, 120000, "requestTimeoutMs"),
    cleanupIntervalMs: readNumber(fileConfig.cleanupIntervalMs, 1000 * 60 * 5, "cleanupIntervalMs"),
    logBody: fileConfig.logBody ?? false,
    recentFallbackLimit: readNumber(fileConfig.recentFallbackLimit, 32, "recentFallbackLimit"),
    recentFallbackMinScore: readNumber(fileConfig.recentFallbackMinScore, 2, "recentFallbackMinScore"),
    sessionMatchMinScore: readNumber(fileConfig.sessionMatchMinScore, 6, "sessionMatchMinScore"),
    sessionMatchMinMargin: readNumber(fileConfig.sessionMatchMinMargin, 3, "sessionMatchMinMargin"),
    lowConfidenceStrategy: readLowConfidenceStrategy(fileConfig.lowConfidenceStrategy),
    forceInjectReasoningEffortNone: fileConfig.forceInjectReasoningEffortNone ?? true,
    namespaceIncludeAuthorization: fileConfig.namespaceIncludeAuthorization ?? true,
    namespaceIncludeUserAgent: fileConfig.namespaceIncludeUserAgent ?? true,
    namespaceIncludeIp: fileConfig.namespaceIncludeIp ?? false,
    allowUserScopedSessions: fileConfig.allowUserScopedSessions ?? false,
    sessionStoreDriver,
    sessionStoreFilePath: fileConfig.sessionStoreFilePath ?? "./data/sessions.sqlite",
    redisUrl: fileConfig.redisUrl,
    redisKeyPrefix: fileConfig.redisKeyPrefix ?? "reasoning-bridge",
    maxSessions: readNumber(fileConfig.maxSessions, 5000, "maxSessions"),
    maxTurnsPerSession: readNumber(fileConfig.maxTurnsPerSession, 48, "maxTurnsPerSession"),
    maxStoreBytes: readNumber(fileConfig.maxStoreBytes, 536870912, "maxStoreBytes")
  };
}
