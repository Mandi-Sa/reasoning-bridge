import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createSessionStore } from "./store/session-store.js";
import type { SessionRecord } from "./types.js";

interface SessionRow {
  payload: string;
}

function parseArgs(argv: string[]): {
  source: string;
  batchSize: number;
  dryRun: boolean;
  clearTarget: boolean;
} {
  let source = "";
  let batchSize = 500;
  let dryRun = false;
  let clearTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source") {
      source = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--batch-size") {
      const parsed = Number(argv[index + 1] ?? "500");
      if (Number.isFinite(parsed) && parsed > 0) {
        batchSize = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--clear-target") {
      clearTarget = true;
    }
  }

  return { source, batchSize, dryRun, clearTarget };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.redisUrl) {
    throw new Error("redisUrl is required in config.json for SQLite -> Redis migration.");
  }

  const args = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(args.source || config.sessionStoreFilePath);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  const store = await createSessionStore("redis", {
    filePath: sourcePath,
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    limits: {
      maxSessions: config.maxSessions,
      maxTurnsPerSession: config.maxTurnsPerSession,
      maxStoreBytes: config.maxStoreBytes
    }
  });

  try {
    const totalRow = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const totalSessions = totalRow.count;

    if (args.clearTarget && !args.dryRun) {
      const recent = await store.getStats(1000);
      console.log(JSON.stringify({
        action: "clear-target-skipped",
        reason: "Current Redis store implementation does not expose a destructive clear-all API.",
        existingSessionCountEstimate: recent.sessionCount
      }, null, 2));
    }

    console.log(JSON.stringify({
      action: args.dryRun ? "dry-run" : "migrate",
      sourcePath,
      targetDriver: "redis",
      redisUrl: config.redisUrl,
      redisKeyPrefix: config.redisKeyPrefix,
      totalSessions,
      batchSize: args.batchSize
    }, null, 2));

    let migrated = 0;
    let skipped = 0;

    for (let offset = 0; offset < totalSessions; offset += args.batchSize) {
      const rows = db.prepare(`
        SELECT payload
        FROM sessions
        ORDER BY updated_at ASC
        LIMIT ? OFFSET ?
      `).all(args.batchSize, offset) as unknown as SessionRow[];

      for (const row of rows) {
        const session = JSON.parse(row.payload) as SessionRecord;
        if (args.dryRun) {
          migrated += 1;
          continue;
        }

        const existing = await store.get(session.sessionKey);
        if (existing && existing.updatedAt >= session.updatedAt) {
          skipped += 1;
          continue;
        }

        await store.set(session);
        migrated += 1;
      }

      console.log(JSON.stringify({
        progress: {
          processed: Math.min(offset + rows.length, totalSessions),
          total: totalSessions,
          migrated,
          skipped
        }
      }));
    }

    const finalStats = await store.getStats(10);
    console.log(JSON.stringify({
      done: true,
      sourcePath,
      migrated,
      skipped,
      targetSessionCount: finalStats.sessionCount,
      targetEstimatedBytes: finalStats.estimatedBytes,
      targetRecentSessionKeys: finalStats.recentSessionKeys
    }, null, 2));
  } finally {
    db.close();
    if (store.close) {
      await store.close();
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
