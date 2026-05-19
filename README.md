# Reasoning Bridge

[English](./README.md) | [简体中文](./README.zh-CN.md)

Reasoning Bridge is a compatibility proxy for OpenAI-style chat clients that do not send back historical `reasoning_content` in later turns.

It accepts downstream `/v1/chat/completions` requests, repairs missing assistant-side `reasoning_content` from locally stored session state, and forwards the repaired request to an upstream reasoning-capable API.

## When You Need It

You are likely to need this bridge when an OpenAI-compatible client can talk to a reasoning model, but does not replay prior assistant `reasoning_content` on the next turn.

For example, when clients such as Codex connect to APIs such as DeepSeek or Mimo, follow-up requests can fail with a `400 Bad Request` because the upstream reasoning model expects the previous assistant reasoning context to be present, while the client only sends the visible conversation messages.

In that setup, Reasoning Bridge reconstructs the missing reasoning payload from stored session state before forwarding the request upstream.

## Features

- OpenAI-style `/v1/chat/completions` compatibility
- Multi-turn conversation repair for missing `reasoning_content`
- Assistant messages with `tool_calls`
- Streaming (`stream: true`) passthrough with side-channel response assembly
- Session storage with `memory`, `sqlite`, or `redis`
- Capacity-based cleanup with LRU-style eviction
- Layered repair matching with strict, loose, content-only, and tool-call-based fallbacks
- Basic health and debug endpoints
- SQLite to Redis migration
- Redis to SQLite migration

## Requirements

- Node.js 24+
- npm 10+

## Install

```bash
npm install
```

Create a local config file:

```bash
cp config.example.json config.json
```

## Run

Development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Start:

```bash
npm start
```

## Configuration

Runtime configuration is loaded from `config.json` by default. You can also point to a different file with `BRIDGE_CONFIG_PATH`.

Example `config.example.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "upstreamBaseUrl": "http://127.0.0.1:8000",
  "upstreamApiKey": "replace-me",
  "upstreamPath": "/v1/chat/completions",
  "requestTimeoutMs": 600000,
  "cleanupIntervalMs": 300000,
  "logBody": false,
  "recentFallbackLimit": 32,
  "recentFallbackMinScore": 2,
  "sessionMatchMinScore": 6,
  "sessionMatchMinMargin": 3,
  "lowConfidenceStrategy": "disable-thinking",
  "forceInjectReasoningEffortNone": true,
  "namespaceIncludeAuthorization": true,
  "namespaceIncludeUserAgent": true,
  "namespaceIncludeIp": false,
  "allowCrossNamespaceRecovery": false,
  "crossNamespaceMinScore": 10,
  "crossNamespaceMinMargin": 4,
  "allowUserScopedSessions": false,
  "sessionStoreDriver": "sqlite",
  "sessionStoreFilePath": "./data/sessions.sqlite",
  "redisUrl": "redis://127.0.0.1:6379/12",
  "redisKeyPrefix": "reasoning-bridge",
  "maxSessions": 100000,
  "maxTurnsPerSession": 48,
  "maxStoreBytes": 4294967296
}
```

Key fields:

- `host`: bind address
- `port`: listen port
- `upstreamBaseUrl`: upstream base URL
- `upstreamApiKey`: upstream bearer token
- `upstreamPath`: upstream chat completion path
- `requestTimeoutMs`: upstream request timeout
- `cleanupIntervalMs`: background cleanup interval
- `logBody`: enable request body logging
- `recentFallbackLimit`: recent-session fallback search size
- `recentFallbackMinScore`: minimum score for recent-session fallback
- `sessionMatchMinScore`: minimum score required before the bridge trusts an inferred session
- `sessionMatchMinMargin`: minimum lead over the runner-up candidate when multiple sessions compete
- `lowConfidenceStrategy`: `warn`, `disable-thinking`, or `reject`
- `forceInjectReasoningEffortNone`: when `true`, the bridge injects `reasoning_effort: "none"` by default if reasoning repair fails and the incoming request did not expose an explicit toggle
- `namespaceIncludeAuthorization`: include downstream `Authorization` in the namespace key
- `namespaceIncludeUserAgent`: include downstream `User-Agent` in the namespace key
- `namespaceIncludeIp`: include downstream IP-derived data in the namespace key. Default is `false` because IPs behind CDNs, reverse proxies, or CGNAT are often unstable
- `allowCrossNamespaceRecovery`: allow recent-session recovery across namespaces when local namespace lookup fails
- `crossNamespaceMinScore`: minimum candidate score required before the bridge trusts a cross-namespace recovery
- `crossNamespaceMinMargin`: minimum lead over the runner-up candidate for cross-namespace recovery when multiple candidates compete
- `allowUserScopedSessions`: when `true`, the bridge may use the request `user` field as an explicit session key. Keep this `false` unless your callers guarantee stable, unique `user` values.
- `sessionStoreDriver`: `memory`, `sqlite`, or `redis`
- `sessionStoreFilePath`: SQLite file path
- `redisUrl`: Redis connection URL, optionally including DB index
- `redisKeyPrefix`: Redis key namespace prefix
- `maxSessions`: maximum retained sessions
- `maxTurnsPerSession`: maximum retained assistant turns per session
- `maxStoreBytes`: maximum retained store size

## Storage Backends

### memory

- Fast setup
- Volatile
- Intended for testing only

### sqlite

- Local persistence
- Simple single-node deployment

### redis

- Shared state across multiple processes or instances
- Suitable for multi-client and multi-instance deployments
- Key isolation is controlled by `redisKeyPrefix`
- `maxStoreBytes` is estimated from the bridge-owned Redis prefix, not from total Redis instance memory

## Debug Endpoints

- `GET /healthz`
- `GET /debug/status`
- `GET /debug/metrics`
- `GET /debug/store?limit=10`
- `POST /v1/chat/completions`

What each endpoint returns:

- `GET /healthz`: Minimal liveness check. Returns `ok` and the service name.
- `GET /debug/status`: Full bridge overview. Includes config summary, runtime metrics, and session store statistics.
- `GET /debug/metrics`: Runtime counters only. Useful when you only want request, error, timeout, and stream interruption metrics.
- `GET /debug/store`: Session store details only. Supports `limit` from `1` to `100` and returns recent session keys with store-level stats.
- `POST /v1/chat/completions`: Main proxy endpoint. It forwards the repaired request upstream and adds bridge-specific diagnostic headers to the response.

Bridge diagnostic response headers:

- `x-reasoning-bridge-session-key`: Resolved internal session key used for this request.
- `x-reasoning-bridge-session-source`: How the session was resolved, such as `explicit`, `bootstrap`, `context-key`, `recent-fallback`, or `created`.
- `x-reasoning-bridge-anchor-key`: The computed anchor key for the request.
- `x-reasoning-bridge-bootstrap-key`: The computed bootstrap key when available.
- `x-reasoning-bridge-namespace-key`: The downstream namespace used to isolate clients.
- `x-reasoning-bridge-match-score`: Candidate match score for repaired multi-turn context lookup.
- `x-reasoning-bridge-request-model`: Final upstream model value used by the bridge.
- `x-reasoning-bridge-warning`: Present when the bridge detected missing reasoning, low-confidence session matching, or had to disable thinking mode.

Examples:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/debug/status
curl http://127.0.0.1:8787/debug/metrics
curl "http://127.0.0.1:8787/debug/store?limit=20"
```

Inspect response headers from the main proxy endpoint:

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"hello"}]}'
```

## Migration

SQLite to Redis:

```bash
npm run migrate:sqlite-to-redis -- --dry-run
npm run migrate:sqlite-to-redis -- --source ./data/sessions.sqlite
npm run migrate:sqlite-to-redis
```

Redis to SQLite:

```bash
npm run migrate:redis-to-sqlite -- --dry-run
npm run migrate:redis-to-sqlite -- --target ./data/recovered-sessions.sqlite
npm run migrate:redis-to-sqlite
```

These migration commands compile the project before running, so they work in production-style environments where `devDependencies` such as `tsx` are not installed.

## Recommended Redis Usage

If Redis is shared with other applications:

- Use a dedicated Redis DB when possible
- Use a unique `redisKeyPrefix`
- Treat `redisKeyPrefix` as the logical namespace for this bridge

## Notes

- The bridge does not rely on TTL-based expiration
- Cleanup is capacity-driven
- Redis size accounting is application-level estimation, not Redis internal exact memory accounting
