import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient, type RedisClientType } from "redis";
import type { AssistantTurn, InflightRequestRecord, SessionRecord, StoreStatsSnapshot } from "../types.js";

export interface SessionStore {
  get(sessionKey: string): Promise<SessionRecord | undefined>;
  set(session: SessionRecord): Promise<void>;
  touch(sessionKey: string): Promise<SessionRecord | undefined>;
  listByAnchor(anchorKey: string): Promise<SessionRecord[]>;
  listByBootstrapKey(bootstrapKey: string): Promise<SessionRecord[]>;
  listRecent(limit?: number): Promise<SessionRecord[]>;
  setBootstrapKey(sessionKey: string, bootstrapKey: string): Promise<void>;
  addContextKey(sessionKey: string, contextKey: string): Promise<void>;
  appendTurn(sessionKey: string, turn: AssistantTurn): Promise<boolean>;
  markInflight(sessionKey: string, inflight: InflightRequestRecord): Promise<void>;
  clearInflight(sessionKey: string, requestHash: string): Promise<void>;
  cleanup(): Promise<void>;
  getStats(limit?: number): Promise<StoreStatsSnapshot>;
  close?(): Promise<void>;
  flush?(): Promise<void>;
}

export interface SessionStoreLimits {
  maxSessions: number;
  maxTurnsPerSession: number;
  maxStoreBytes: number;
}

interface SessionStoreOptions {
  filePath: string;
  redisUrl?: string | undefined;
  redisKeyPrefix?: string | undefined;
  limits: SessionStoreLimits;
}

function summarizeSessions(sessions: SessionRecord[]): Pick<StoreStatsSnapshot, "inflightCount" | "totalTurns" | "sessionsWithBootstrapKey"> {
  return sessions.reduce((totals, session) => ({
    inflightCount: totals.inflightCount + session.inflightRequests.length,
    totalTurns: totals.totalTurns + session.turns.length,
    sessionsWithBootstrapKey: totals.sessionsWithBootstrapKey + (session.bootstrapKey ? 1 : 0)
  }), {
    inflightCount: 0,
    totalTurns: 0,
    sessionsWithBootstrapKey: 0
  });
}

class SessionMutationLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(sessionKey: string, action: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(sessionKey) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.tails.set(sessionKey, next);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(sessionKey) === next) {
        this.tails.delete(sessionKey);
      }
    }
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly anchorIndex = new Map<string, Set<string>>();
  private readonly bootstrapIndex = new Map<string, Set<string>>();
  private readonly limits: SessionStoreLimits;
  private readonly locks = new SessionMutationLocks();

  constructor(limits: SessionStoreLimits) {
    this.limits = limits;
  }

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(sessionKey);
  }

  async set(session: SessionRecord): Promise<void> {
    await this.locks.run(session.sessionKey, async () => {
      this.sessions.set(session.sessionKey, this.normalizeSession(session));
      await this.rebuildIndexesForSession(session.sessionKey);
      await this.pruneToLimits();
    });
  }

  async touch(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.locks.run(sessionKey, () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return undefined;
      }
      session.updatedAt = Date.now();
      return session;
    });
  }

  async listByAnchor(anchorKey: string): Promise<SessionRecord[]> {
    const keys = this.anchorIndex.get(anchorKey);
    if (!keys) {
      return [];
    }
    return [...keys]
      .map((key) => this.sessions.get(key))
      .filter((session): session is SessionRecord => Boolean(session))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listByBootstrapKey(bootstrapKey: string): Promise<SessionRecord[]> {
    const keys = this.bootstrapIndex.get(bootstrapKey);
    if (!keys) {
      return [];
    }
    return [...keys]
      .map((key) => this.sessions.get(key))
      .filter((session): session is SessionRecord => Boolean(session))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listRecent(limit = 32): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  async setBootstrapKey(sessionKey: string, bootstrapKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return;
      }
      session.bootstrapKey = bootstrapKey;
      await this.rebuildIndexesForSession(sessionKey);
    });
  }

  async addContextKey(sessionKey: string, contextKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return;
      }
      if (!session.contextKeys.includes(contextKey)) {
        session.contextKeys.push(contextKey);
        session.contextKeys = session.contextKeys.slice(-16);
        await this.rebuildIndexesForSession(sessionKey);
      }
    });
  }

  async appendTurn(sessionKey: string, turn: AssistantTurn): Promise<boolean> {
    return this.locks.run(sessionKey, () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return false;
      }

      const exists = session.turns.some((existing) =>
        existing.turnId === turn.turnId ||
        (existing.requestHash === turn.requestHash && existing.fingerprint.strict === turn.fingerprint.strict)
      );
      if (exists) {
        return false;
      }

      session.turns.push(turn);
      session.turns = session.turns.slice(-this.limits.maxTurnsPerSession);
      session.updatedAt = Date.now();
      return true;
    });
  }

  async markInflight(sessionKey: string, inflight: InflightRequestRecord): Promise<void> {
    await this.locks.run(sessionKey, () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return;
      }
      const exists = session.inflightRequests.some((item) => item.requestHash === inflight.requestHash);
      if (!exists) {
        session.inflightRequests.push(inflight);
      }
      session.requestHashes = [inflight.requestHash, ...session.requestHashes.filter((value) => value !== inflight.requestHash)].slice(0, 64);
      session.updatedAt = Date.now();
    });
  }

  async clearInflight(sessionKey: string, requestHash: string): Promise<void> {
    await this.locks.run(sessionKey, () => {
      const session = this.sessions.get(sessionKey);
      if (!session) {
        return;
      }
      session.inflightRequests = session.inflightRequests.filter((item) => item.requestHash !== requestHash);
    });
  }

  async cleanup(): Promise<void> {
    await this.pruneToLimits();
  }

  async getStats(limit = 10): Promise<StoreStatsSnapshot> {
    const sessions = [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const totals = summarizeSessions(sessions);
    return {
      driver: "memory",
      sessionCount: sessions.length,
      estimatedBytes: Buffer.byteLength(JSON.stringify(sessions), "utf8"),
      inflightCount: totals.inflightCount,
      totalTurns: totals.totalTurns,
      sessionsWithBootstrapKey: totals.sessionsWithBootstrapKey,
      recentSessionKeys: sessions.slice(0, limit).map((session) => session.sessionKey),
      limits: {
        maxSessions: this.limits.maxSessions,
        maxTurnsPerSession: this.limits.maxTurnsPerSession,
        maxStoreBytes: this.limits.maxStoreBytes
      },
      backend: {
        anchorIndexSize: this.anchorIndex.size,
        bootstrapIndexSize: this.bootstrapIndex.size
      }
    };
  }

  private normalizeSession(session: SessionRecord): SessionRecord {
    return {
      ...session,
      contextKeys: [...new Set([session.anchorKey, ...session.contextKeys])].slice(-16),
      turns: session.turns.slice(-this.limits.maxTurnsPerSession),
      requestHashes: session.requestHashes.slice(0, 64),
      inflightRequests: session.inflightRequests.slice(0, 64)
    };
  }

  private async rebuildIndexesForSession(sessionKey: string): Promise<void> {
    for (const value of this.anchorIndex.values()) {
      value.delete(sessionKey);
    }
    for (const value of this.bootstrapIndex.values()) {
      value.delete(sessionKey);
    }

    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    for (const contextKey of session.contextKeys) {
      const existing = this.anchorIndex.get(contextKey) ?? new Set<string>();
      existing.add(sessionKey);
      this.anchorIndex.set(contextKey, existing);
    }

    if (session.bootstrapKey) {
      const existing = this.bootstrapIndex.get(session.bootstrapKey) ?? new Set<string>();
      existing.add(sessionKey);
      this.bootstrapIndex.set(session.bootstrapKey, existing);
    }
  }

  private async pruneToLimits(): Promise<void> {
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) {
        break;
      }
      this.sessions.delete(oldest.sessionKey);
      await this.rebuildIndexesForSession(oldest.sessionKey);
    }
  }
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private readonly filePath: string;
  private readonly limits: SessionStoreLimits;
  private readonly locks = new SessionMutationLocks();

  constructor(filePath: string, limits: SessionStoreLimits) {
    const resolvedPath = resolve(filePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.filePath = resolvedPath;
    this.limits = limits;
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        anchor_key TEXT NOT NULL,
        bootstrap_key TEXT,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_context_keys (
        session_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        PRIMARY KEY (session_key, context_key),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_bootstrap_key ON sessions(bootstrap_key);
      CREATE INDEX IF NOT EXISTS idx_context_keys_context_key ON session_context_keys(context_key);
    `);
  }

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare("SELECT payload FROM sessions WHERE session_key = ?").get(sessionKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as SessionRecord : undefined;
  }

  async set(session: SessionRecord): Promise<void> {
    await this.locks.run(session.sessionKey, () => this.persistSession(session));
  }

  async touch(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return undefined;
      }
      session.updatedAt = Date.now();
      this.persistSession(session);
      return session;
    });
  }

  async listByAnchor(anchorKey: string): Promise<SessionRecord[]> {
    const rows = this.db.prepare(`
      SELECT s.payload
      FROM sessions s
      INNER JOIN session_context_keys c ON c.session_key = s.session_key
      WHERE c.context_key = ?
      ORDER BY s.updated_at DESC
    `).all(anchorKey) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as SessionRecord);
  }

  async listByBootstrapKey(bootstrapKey: string): Promise<SessionRecord[]> {
    const rows = this.db.prepare(`
      SELECT payload
      FROM sessions
      WHERE bootstrap_key = ?
      ORDER BY updated_at DESC
    `).all(bootstrapKey) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as SessionRecord);
  }

  async listRecent(limit = 32): Promise<SessionRecord[]> {
    const rows = this.db.prepare(`
      SELECT payload
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as SessionRecord);
  }

  async setBootstrapKey(sessionKey: string, bootstrapKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      session.bootstrapKey = bootstrapKey;
      this.persistSession(session);
    });
  }

  async addContextKey(sessionKey: string, contextKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      if (!session.contextKeys.includes(contextKey)) {
        session.contextKeys.push(contextKey);
        session.contextKeys = session.contextKeys.slice(-16);
        this.persistSession(session);
      }
    });
  }

  async appendTurn(sessionKey: string, turn: AssistantTurn): Promise<boolean> {
    return this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return false;
      }
      const exists = session.turns.some((existing) =>
        existing.turnId === turn.turnId ||
        (existing.requestHash === turn.requestHash && existing.fingerprint.strict === turn.fingerprint.strict)
      );
      if (exists) {
        return false;
      }
      session.turns.push(turn);
      session.turns = session.turns.slice(-this.limits.maxTurnsPerSession);
      session.updatedAt = Date.now();
      this.persistSession(session);
      return true;
    });
  }

  async markInflight(sessionKey: string, inflight: InflightRequestRecord): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      const exists = session.inflightRequests.some((item) => item.requestHash === inflight.requestHash);
      if (!exists) {
        session.inflightRequests.push(inflight);
      }
      session.requestHashes = [inflight.requestHash, ...session.requestHashes.filter((value) => value !== inflight.requestHash)].slice(0, 64);
      session.updatedAt = Date.now();
      this.persistSession(session);
    });
  }

  async clearInflight(sessionKey: string, requestHash: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      session.inflightRequests = session.inflightRequests.filter((item) => item.requestHash !== requestHash);
      this.persistSession(session);
    });
  }

  async cleanup(): Promise<void> {
    this.pruneToLimits();
  }

  async close(): Promise<void> {
    return;
  }

  async getStats(limit = 10): Promise<StoreStatsSnapshot> {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const payloadRows = this.db.prepare(`
      SELECT payload
      FROM sessions
    `).all() as Array<{ payload: string }>;
    const sessions = payloadRows.map((row) => JSON.parse(row.payload) as SessionRecord);
    const totals = summarizeSessions(sessions);
    const keyRows = this.db.prepare(`
      SELECT session_key
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ session_key: string }>;

    return {
      driver: "sqlite",
      sessionCount: countRow.count,
      estimatedBytes: this.safeSqliteTotalSize(),
      inflightCount: totals.inflightCount,
      totalTurns: totals.totalTurns,
      sessionsWithBootstrapKey: totals.sessionsWithBootstrapKey,
      recentSessionKeys: keyRows.map((row) => row.session_key),
      limits: {
        maxSessions: this.limits.maxSessions,
        maxTurnsPerSession: this.limits.maxTurnsPerSession,
        maxStoreBytes: this.limits.maxStoreBytes
      },
      backend: {
        filePath: this.filePath
      }
    };
  }

  async flush(): Promise<void> {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  private persistSession(session: SessionRecord): void {
    const normalized: SessionRecord = {
      ...session,
      contextKeys: [...new Set([session.anchorKey, ...session.contextKeys])].slice(-16),
      turns: session.turns.slice(-this.limits.maxTurnsPerSession),
      requestHashes: session.requestHashes.slice(0, 64),
      inflightRequests: session.inflightRequests.slice(0, 64)
    };

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare(`
        INSERT INTO sessions (
          session_key,
          anchor_key,
          bootstrap_key,
          model,
          updated_at,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          anchor_key = excluded.anchor_key,
          bootstrap_key = excluded.bootstrap_key,
          model = excluded.model,
          updated_at = excluded.updated_at,
          payload = excluded.payload
      `).run(
        normalized.sessionKey,
        normalized.anchorKey,
        normalized.bootstrapKey ?? null,
        normalized.model,
        normalized.updatedAt,
        JSON.stringify(normalized)
      );

      this.db.prepare("DELETE FROM session_context_keys WHERE session_key = ?").run(normalized.sessionKey);
      const insertContext = this.db.prepare(`
        INSERT OR IGNORE INTO session_context_keys (session_key, context_key)
        VALUES (?, ?)
      `);
      for (const contextKey of normalized.contextKeys) {
        insertContext.run(normalized.sessionKey, contextKey);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.pruneToLimits();
  }

  private pruneToLimits(): void {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const overflow = Math.max(0, countRow.count - this.limits.maxSessions);
    if (overflow > 0) {
      this.db.prepare(`
        DELETE FROM sessions
        WHERE session_key IN (
          SELECT session_key
          FROM sessions
          ORDER BY updated_at ASC
          LIMIT ?
        )
      `).run(overflow);
    }

    let sizeBytes = this.safeSqliteTotalSize();
    while (sizeBytes > this.limits.maxStoreBytes) {
      const result = this.db.prepare(`
        DELETE FROM sessions
        WHERE session_key IN (
          SELECT session_key
          FROM sessions
          ORDER BY updated_at ASC
          LIMIT 1
        )
      `).run();
      if ((result.changes ?? 0) === 0) {
        break;
      }
      sizeBytes = this.safeSqliteTotalSize();
    }
  }

  private safeSqliteTotalSize(): number {
    return [
      this.filePath,
      `${this.filePath}-wal`,
      `${this.filePath}-shm`
    ].reduce((total, filePath) => total + this.safeFileSize(filePath), 0);
  }

  private safeFileSize(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }
}

export class RedisSessionStore implements SessionStore {
  private readonly client: RedisClientType;
  private readonly txClient: RedisClientType;
  private readonly prefix: string;
  private readonly limits: SessionStoreLimits;
  private readonly ready: Promise<void>;
  private readonly locks = new SessionMutationLocks();
  private readonly mutationLock = new SessionMutationLocks();

  constructor(redisUrl: string, keyPrefix: string, limits: SessionStoreLimits) {
    this.client = createClient({ url: redisUrl });
    this.txClient = this.client.duplicate();
    this.prefix = keyPrefix;
    this.limits = limits;
    this.ready = Promise.all([
      this.client.connect(),
      this.txClient.connect()
    ]).then(() => undefined);
  }

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    await this.ready;
    const value = await this.client.get(this.sessionKey(sessionKey));
    return value ? JSON.parse(value) as SessionRecord : undefined;
  }

  async set(session: SessionRecord): Promise<void> {
    await this.ready;
    await this.locks.run(session.sessionKey, () => this.persistSession(session));
  }

  async touch(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return undefined;
      }
      session.updatedAt = Date.now();
      await this.persistSession(session);
      return session;
    });
  }

  async listByAnchor(anchorKey: string): Promise<SessionRecord[]> {
    await this.ready;
    const sessionKeys = await this.client.sMembers(this.anchorSetKey(anchorKey));
    return this.loadSessions(sessionKeys);
  }

  async listByBootstrapKey(bootstrapKey: string): Promise<SessionRecord[]> {
    await this.ready;
    const sessionKeys = await this.client.sMembers(this.bootstrapSetKey(bootstrapKey));
    return this.loadSessions(sessionKeys);
  }

  async listRecent(limit = 32): Promise<SessionRecord[]> {
    await this.ready;
    const sessionKeys = await this.client.zRange(this.lruKey(), -limit, -1);
    return this.loadSessions(sessionKeys.reverse());
  }

  async setBootstrapKey(sessionKey: string, bootstrapKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      session.bootstrapKey = bootstrapKey;
      await this.persistSession(session);
    });
  }

  async addContextKey(sessionKey: string, contextKey: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      if (!session.contextKeys.includes(contextKey)) {
        session.contextKeys.push(contextKey);
        session.contextKeys = session.contextKeys.slice(-16);
        await this.persistSession(session);
      }
    });
  }

  async appendTurn(sessionKey: string, turn: AssistantTurn): Promise<boolean> {
    return this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return false;
      }
      const exists = session.turns.some((existing) =>
        existing.turnId === turn.turnId ||
        (existing.requestHash === turn.requestHash && existing.fingerprint.strict === turn.fingerprint.strict)
      );
      if (exists) {
        return false;
      }
      session.turns.push(turn);
      session.turns = session.turns.slice(-this.limits.maxTurnsPerSession);
      session.updatedAt = Date.now();
      await this.persistSession(session);
      return true;
    });
  }

  async markInflight(sessionKey: string, inflight: InflightRequestRecord): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      const exists = session.inflightRequests.some((item) => item.requestHash === inflight.requestHash);
      if (!exists) {
        session.inflightRequests.push(inflight);
      }
      session.requestHashes = [inflight.requestHash, ...session.requestHashes.filter((value) => value !== inflight.requestHash)].slice(0, 64);
      session.updatedAt = Date.now();
      await this.persistSession(session);
    });
  }

  async clearInflight(sessionKey: string, requestHash: string): Promise<void> {
    await this.locks.run(sessionKey, async () => {
      const session = await this.get(sessionKey);
      if (!session) {
        return;
      }
      session.inflightRequests = session.inflightRequests.filter((item) => item.requestHash !== requestHash);
      await this.persistSession(session);
    });
  }

  async cleanup(): Promise<void> {
    await this.ready;
    await this.withMutationLock(() => this.pruneToLimitsLocked());
  }

  async close(): Promise<void> {
    await this.ready;
    await Promise.all([
      this.client.quit(),
      this.txClient.quit()
    ]);
  }

  async exportAllSessions(): Promise<SessionRecord[]> {
    await this.ready;
    const sessionKeys = await this.client.zRange(this.lruKey(), 0, -1);
    return this.loadSessions(sessionKeys);
  }

  async getStats(limit = 10): Promise<StoreStatsSnapshot> {
    await this.ready;
    const sessionCount = await this.client.zCard(this.lruKey());
    const recentSessionKeys = (await this.client.zRange(this.lruKey(), -limit, -1)).reverse();
    const allSessionKeys = await this.client.zRange(this.lruKey(), 0, -1);
    const sessions = await this.loadSessions(allSessionKeys);
    const totals = summarizeSessions(sessions);
    const usedMemory = await this.estimateOwnedBytes();
    const bootstrapKeyCount = await this.countKeysByPattern(`${this.prefix}:bootstrap:*`);
    const anchorKeyCount = await this.countKeysByPattern(`${this.prefix}:anchor:*`);

    return {
      driver: "redis",
      sessionCount,
      estimatedBytes: usedMemory,
      inflightCount: totals.inflightCount,
      totalTurns: totals.totalTurns,
      sessionsWithBootstrapKey: totals.sessionsWithBootstrapKey,
      recentSessionKeys,
      limits: {
        maxSessions: this.limits.maxSessions,
        maxTurnsPerSession: this.limits.maxTurnsPerSession,
        maxStoreBytes: this.limits.maxStoreBytes
      },
      backend: {
        redisPrefix: this.prefix,
        anchorSetCount: anchorKeyCount,
        bootstrapSetCount: bootstrapKeyCount
      }
    };
  }

  private async persistSession(session: SessionRecord): Promise<void> {
    const normalized: SessionRecord = {
      ...session,
      contextKeys: [...new Set([session.anchorKey, ...session.contextKeys])].slice(-16),
      turns: session.turns.slice(-this.limits.maxTurnsPerSession),
      requestHashes: session.requestHashes.slice(0, 64),
      inflightRequests: session.inflightRequests.slice(0, 64)
    };

    await this.withMutationLock(async () => {
      const storageKey = this.sessionKey(normalized.sessionKey);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await this.txClient.watch(storageKey);
        try {
          const oldSession = await this.readSession(this.txClient, normalized.sessionKey);
          const pipeline = this.txClient.multi();
          pipeline.set(storageKey, JSON.stringify(normalized));
          pipeline.zAdd(this.lruKey(), { score: normalized.updatedAt, value: normalized.sessionKey });

          if (oldSession?.bootstrapKey && oldSession.bootstrapKey !== normalized.bootstrapKey) {
            pipeline.sRem(this.bootstrapSetKey(oldSession.bootstrapKey), normalized.sessionKey);
          }
          if (normalized.bootstrapKey) {
            pipeline.sAdd(this.bootstrapSetKey(normalized.bootstrapKey), normalized.sessionKey);
          }

          const oldContextKeys = new Set(oldSession?.contextKeys ?? []);
          const newContextKeys = new Set(normalized.contextKeys);
          for (const contextKey of oldContextKeys) {
            if (!newContextKeys.has(contextKey)) {
              pipeline.sRem(this.anchorSetKey(contextKey), normalized.sessionKey);
            }
          }
          for (const contextKey of newContextKeys) {
            pipeline.sAdd(this.anchorSetKey(contextKey), normalized.sessionKey);
          }

          await pipeline.exec();
          await this.pruneToLimitsLocked();
          return;
        } catch (error) {
          await this.safeUnwatch();
          if (this.isWatchError(error)) {
            continue;
          }
          throw error;
        }
      }

      throw new Error(`failed to persist Redis session after concurrent modification: ${normalized.sessionKey}`);
    });
  }

  private async loadSessions(sessionKeys: string[]): Promise<SessionRecord[]> {
    if (!sessionKeys.length) {
      return [];
    }
    const values = await this.client.mGet(sessionKeys.map((sessionKey) => this.sessionKey(sessionKey)));
    return values
      .filter((value): value is string => Boolean(value))
      .map((value) => JSON.parse(value) as SessionRecord)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async pruneToLimitsLocked(): Promise<void> {
    const sessionCount = await this.txClient.zCard(this.lruKey());
    const overflow = Math.max(0, sessionCount - this.limits.maxSessions);
    if (overflow > 0) {
      const victims = await this.txClient.zRange(this.lruKey(), 0, overflow - 1);
      for (const victim of victims) {
        await this.deleteSessionLocked(victim);
      }
    }

    let usedMemory = await this.estimateOwnedBytes();
    if (usedMemory > this.limits.maxStoreBytes) {
      while (true) {
        const nextVictim = await this.txClient.zRange(this.lruKey(), 0, 0);
        const victim = nextVictim[0];
        if (!victim) {
          break;
        }
        await this.deleteSessionLocked(victim);
        usedMemory = await this.estimateOwnedBytes();
        if (usedMemory <= this.limits.maxStoreBytes) {
          break;
        }
      }
    }
  }

  private async deleteSessionLocked(sessionKey: string): Promise<void> {
    const storageKey = this.sessionKey(sessionKey);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.txClient.watch(storageKey);
      try {
        const session = await this.readSession(this.txClient, sessionKey);
        const pipeline = this.txClient.multi();
        pipeline.del(storageKey);
        pipeline.zRem(this.lruKey(), sessionKey);
        if (session?.bootstrapKey) {
          pipeline.sRem(this.bootstrapSetKey(session.bootstrapKey), sessionKey);
        }
        for (const contextKey of session?.contextKeys ?? []) {
          pipeline.sRem(this.anchorSetKey(contextKey), sessionKey);
        }
        await pipeline.exec();
        return;
      } catch (error) {
        await this.safeUnwatch();
        if (this.isWatchError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`failed to delete Redis session after concurrent modification: ${sessionKey}`);
  }

  private async readSession(client: RedisClientType, sessionKey: string): Promise<SessionRecord | undefined> {
    const value = await client.get(this.sessionKey(sessionKey));
    return value ? JSON.parse(value) as SessionRecord : undefined;
  }

  private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    return this.mutationLock.run("__redis-store-mutation__", action);
  }

  private async safeUnwatch(): Promise<void> {
    try {
      await this.txClient.unwatch();
    } catch {
      // Ignore cleanup failures after aborted WATCH transactions.
    }
  }

  private isWatchError(error: unknown): boolean {
    return error instanceof Error && error.name === "WatchError";
  }

  private sessionKey(sessionKey: string): string {
    return `${this.prefix}:session:${sessionKey}`;
  }

  private anchorSetKey(anchorKey: string): string {
    return `${this.prefix}:anchor:${anchorKey}`;
  }

  private bootstrapSetKey(bootstrapKey: string): string {
    return `${this.prefix}:bootstrap:${bootstrapKey}`;
  }

  private lruKey(): string {
    return `${this.prefix}:lru`;
  }

  private async estimateOwnedBytes(): Promise<number> {
    let totalBytes = 0;
    const chunkSize = 256;
    let sessionChunk: string[] = [];
    for await (const keys of this.client.scanIterator({
      MATCH: `${this.prefix}:session:*`,
      COUNT: chunkSize
    })) {
      sessionChunk.push(...keys);
      while (sessionChunk.length >= chunkSize) {
        totalBytes += await this.estimateSessionChunkBytes(sessionChunk.slice(0, chunkSize));
        sessionChunk = sessionChunk.slice(chunkSize);
      }
    }
    totalBytes += await this.estimateSessionChunkBytes(sessionChunk);

    totalBytes += await this.estimatePatternKeyBytes(`${this.prefix}:anchor:*`);
    totalBytes += await this.estimatePatternKeyBytes(`${this.prefix}:bootstrap:*`);
    totalBytes += Buffer.byteLength(this.lruKey(), "utf8");

    return totalBytes;
  }

  private async estimateSessionChunkBytes(keys: string[]): Promise<number> {
    if (!keys.length) {
      return 0;
    }
    const values = await this.client.mGet(keys);
    return values.reduce((sum, value, valueIndex) => {
      const key = keys[valueIndex] ?? "";
      const keyBytes = Buffer.byteLength(key, "utf8");
      const valueBytes = Buffer.byteLength(value ?? "", "utf8");
      return sum + keyBytes + valueBytes;
    }, 0);
  }

  private async estimatePatternKeyBytes(pattern: string): Promise<number> {
    let totalBytes = 0;
    for await (const keys of this.client.scanIterator({ MATCH: pattern, COUNT: 256 })) {
      totalBytes += keys.reduce((sum, key) => sum + Buffer.byteLength(key, "utf8"), 0);
    }
    return totalBytes;
  }

  private async countKeysByPattern(pattern: string): Promise<number> {
    let count = 0;
    for await (const keys of this.client.scanIterator({ MATCH: pattern, COUNT: 256 })) {
      count += keys.length;
    }
    return count;
  }
}

export async function createSessionStore(
  driver: "memory" | "sqlite" | "redis",
  options: SessionStoreOptions
): Promise<SessionStore> {
  if (driver === "sqlite") {
    return new SqliteSessionStore(options.filePath, options.limits);
  }
  if (driver === "redis") {
    if (!options.redisUrl) {
      throw new Error("redisUrl is required for RedisSessionStore");
    }
    return new RedisSessionStore(options.redisUrl, options.redisKeyPrefix ?? "reasoning-bridge", options.limits);
  }
  return new InMemorySessionStore(options.limits);
}
