# Reasoning Bridge

[English](./README.md) | [简体中文](./README.zh-CN.md)

Reasoning Bridge 是一个面向 OpenAI 风格聊天客户端的兼容代理，用来解决下游客户端在后续轮次中不回传历史 `reasoning_content` 的问题。

它接收下游的 `/v1/chat/completions` 请求，基于本地保存的会话状态修复缺失的 assistant `reasoning_content`，再把修复后的请求转发给支持推理模式的上游 API。

## 什么时候会用到

当一个兼容 OpenAI 接口的客户端能够调用推理模型，但在下一轮请求里不会把之前 assistant 的 `reasoning_content` 一起回传时，你通常就会需要这个桥接器。

例如，Codex 之类的客户端接入 DeepSeek、Mimo 这类 API 时，后续轮次经常会返回 `400 Bad Request`：上游推理模型要求请求中带上上一轮 assistant 的推理上下文，但客户端通常只会发送用户可见的消息内容，导致请求上下文不完整。

在这种场景下，Reasoning Bridge 会先从本地保存的会话状态中补回缺失的推理内容，再把修复后的请求转发给上游。

## 功能

- 兼容 OpenAI 风格 `/v1/chat/completions`
- 自动修复多轮对话中缺失的 `reasoning_content`
- 支持包含 `tool_calls` 的 assistant 消息
- 支持 `stream: true` 流式透传，并旁路组装最终 assistant 响应
- 支持 `memory`、`sqlite`、`redis` 三种会话存储
- 支持基于容量的 LRU 风格清理
- 支持分层匹配修复：严格指纹、宽松指纹、仅内容、仅工具调用等回退策略
- 提供基础健康检查和调试接口
- 支持 SQLite 到 Redis 的迁移
- 支持 Redis 到 SQLite 的迁移

## 环境要求

- Node.js 24+
- npm 10+

## 安装

```bash
npm install
```

创建本地配置文件：

```bash
cp config.example.json config.json
```

## 运行

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

启动：

```bash
npm start
```

## 配置

默认从 `config.json` 读取运行配置。也可以通过 `BRIDGE_CONFIG_PATH` 指向其他配置文件。

示例配置见 `config.example.json`：

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
  "sessionStoreDriver": "sqlite",
  "sessionStoreFilePath": "./data/sessions.sqlite",
  "redisUrl": "redis://127.0.0.1:6379/12",
  "redisKeyPrefix": "reasoning-bridge",
  "maxSessions": 100000,
  "maxTurnsPerSession": 48,
  "maxStoreBytes": 4294967296
}
```

主要字段：

- `host`：监听地址
- `port`：监听端口
- `upstreamBaseUrl`：上游基础地址
- `upstreamApiKey`：上游 Bearer Token
- `upstreamPath`：上游聊天接口路径
- `requestTimeoutMs`：上游请求超时时间
- `cleanupIntervalMs`：后台清理周期
- `logBody`：是否打印请求体日志
- `recentFallbackLimit`：最近会话回退搜索数量
- `recentFallbackMinScore`：最近会话回退的最小匹配分数
- `sessionMatchMinScore`：桥接器接受推断会话前要求达到的最小匹配分数
- `sessionMatchMinMargin`：多个候选会话竞争时，第一名相对第二名至少要领先的分数
- `lowConfidenceStrategy`：可选 `warn`、`disable-thinking`、`reject`
- `forceInjectReasoningEffortNone`：默认为 `true`。当推理修复失败且客户端请求本身没有显式思考开关时，桥接器会主动注入 `reasoning_effort: "none"` 再转发
- `sessionStoreDriver`：可选 `memory`、`sqlite`、`redis`
- `sessionStoreFilePath`：SQLite 文件路径
- `redisUrl`：Redis 连接地址，可包含 DB 库编号
- `redisKeyPrefix`：Redis key 命名空间前缀
- `maxSessions`：最多保留的会话数
- `maxTurnsPerSession`：单个会话最多保留的 assistant 轮次数
- `maxStoreBytes`：最多保留的存储体积

## 存储后端

### memory

- 启动简单
- 数据不持久化
- 仅适合测试

### sqlite

- 本地持久化
- 适合单机部署

### redis

- 支持多进程或多实例共享会话
- 适合多客户端、多实例部署
- 通过 `redisKeyPrefix` 隔离 key 空间
- `maxStoreBytes` 按桥接器自身前缀的数据量估算，不按整个 Redis 实例总内存计算

## 调试接口

- `GET /healthz`
- `GET /debug/status`
- `GET /debug/metrics`
- `GET /debug/store?limit=10`
- `POST /v1/chat/completions`

各端点返回内容说明：

- `GET /healthz`：最基础的存活检查，只返回 `ok` 和服务名。
- `GET /debug/status`：最完整的桥接器状态总览，包含配置摘要、运行时指标和会话存储统计。
- `GET /debug/metrics`：只返回运行时指标，适合单独查看请求量、错误、超时和流中断等统计。
- `GET /debug/store`：只返回会话存储详情，支持 `1` 到 `100` 的 `limit` 参数，会带上最近会话 key 和存储层统计。
- `POST /v1/chat/completions`：主代理入口。桥接器会修复请求后转发到上游，并在响应头里附带调试信息。

桥接器附加的诊断响应头：

- `x-reasoning-bridge-session-key`：本次请求最终使用的内部 session key。
- `x-reasoning-bridge-session-source`：session 的解析来源，例如 `explicit`、`bootstrap`、`context-key`、`recent-fallback`、`created`。
- `x-reasoning-bridge-anchor-key`：本次请求计算出的 anchor key。
- `x-reasoning-bridge-bootstrap-key`：如果存在，则返回本次请求对应的 bootstrap key。
- `x-reasoning-bridge-namespace-key`：用于隔离不同下游客户端的 namespace。
- `x-reasoning-bridge-match-score`：多轮上下文匹配时的候选分数。
- `x-reasoning-bridge-request-model`：桥接器最终用于访问上游的模型名。
- `x-reasoning-bridge-warning`：当桥接器发现缺失推理内容、session 匹配置信度较低，或主动关闭 thinking 模式时会返回。

示例：

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/debug/status
curl http://127.0.0.1:8787/debug/metrics
curl "http://127.0.0.1:8787/debug/store?limit=20"
```

查看主代理接口返回的诊断响应头：

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"hello"}]}'
```

## 数据迁移

SQLite 迁移到 Redis：

```bash
npm run migrate:sqlite-to-redis -- --dry-run
npm run migrate:sqlite-to-redis -- --source ./data/sessions.sqlite
npm run migrate:sqlite-to-redis
```

Redis 迁移到 SQLite：

```bash
npm run migrate:redis-to-sqlite -- --dry-run
npm run migrate:redis-to-sqlite -- --target ./data/recovered-sessions.sqlite
npm run migrate:redis-to-sqlite
```

这些迁移命令在执行前会先编译项目，因此即使是在未安装 `tsx` 这类 `devDependencies` 的生产风格环境里也可以直接运行。

## Redis 使用建议

如果 Redis 与其他应用共享：

- 尽量使用独立的 Redis DB
- 使用唯一的 `redisKeyPrefix`
- 将 `redisKeyPrefix` 视为桥接器自己的逻辑命名空间

## 说明

- 当前实现不依赖 TTL 过期策略
- 清理策略基于容量限制
- Redis 体积统计属于应用层估算，不是 Redis 内部精确内存统计
