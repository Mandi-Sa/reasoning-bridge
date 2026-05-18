import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createSessionStore, RedisSessionStore, SqliteSessionStore } from "./store/session-store.js";
import type { SessionRecord } from "./types.js";

function parseArgs(argv: string[]): {
  target: string;
  dryRun: boolean;
} {
  let target = "";
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      target = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--dry-run") {
      dryRun = true;
    }
  }

  return { target, dryRun };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.redisUrl) {
    throw new Error("redisUrl is required in config.json for Redis -> SQLite migration.");
  }

  const args = parseArgs(process.argv.slice(2));
  const targetPath = resolve(args.target || config.sessionStoreFilePath);
  const sourceStore = await createSessionStore("redis", {
    filePath: targetPath,
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    limits: {
      maxSessions: config.maxSessions,
      maxTurnsPerSession: config.maxTurnsPerSession,
      maxStoreBytes: config.maxStoreBytes
    }
  });

  if (!(sourceStore instanceof RedisSessionStore)) {
    throw new Error("Failed to initialize RedisSessionStore.");
  }

  const targetStore = new SqliteSessionStore(targetPath, {
    maxSessions: config.maxSessions,
    maxTurnsPerSession: config.maxTurnsPerSession,
    maxStoreBytes: config.maxStoreBytes
  });

  try {
    const sessions = await sourceStore.exportAllSessions();
    console.log(JSON.stringify({
      action: args.dryRun ? "dry-run" : "migrate",
      sourceDriver: "redis",
      redisUrl: config.redisUrl,
      redisKeyPrefix: config.redisKeyPrefix,
      targetDriver: "sqlite",
      targetPath,
      totalSessions: sessions.length
    }, null, 2));

    let migrated = 0;
    let skipped = 0;

    for (const session of sessions) {
      if (args.dryRun) {
        migrated += 1;
        continue;
      }

      const existing = await targetStore.get(session.sessionKey);
      if (existing && existing.updatedAt >= session.updatedAt) {
        skipped += 1;
        continue;
      }

      await targetStore.set(normalizeSessionForTarget(session, config.maxTurnsPerSession));
      migrated += 1;
    }

    if (!args.dryRun && targetStore.flush) {
      await targetStore.flush();
    }

    const finalStats = await targetStore.getStats(10);
    console.log(JSON.stringify({
      done: true,
      targetPath,
      migrated,
      skipped,
      targetSessionCount: finalStats.sessionCount,
      targetEstimatedBytes: finalStats.estimatedBytes,
      targetRecentSessionKeys: finalStats.recentSessionKeys
    }, null, 2));
  } finally {
    if (sourceStore.close) {
      await sourceStore.close();
    }
    if (targetStore.close) {
      await targetStore.close();
    }
  }
}

function normalizeSessionForTarget(session: SessionRecord, maxTurnsPerSession: number): SessionRecord {
  return {
    ...session,
    contextKeys: [...new Set([session.anchorKey, ...session.contextKeys])].slice(-16),
    turns: session.turns.slice(-maxTurnsPerSession),
    requestHashes: session.requestHashes.slice(0, 64),
    inflightRequests: session.inflightRequests.slice(0, 64)
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
