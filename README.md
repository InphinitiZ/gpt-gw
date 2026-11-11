# gpt-gw

把公司报销的 ChatGPT 订阅号做成一个共享池，让 Codex 这类客户端用**标准 API key** 接入。
同事不需要登录 ChatGPT，只需要一个网关发的 `gw_` key。

零依赖，Node ≥ 20 直接跑。

```bash
node src/server.mjs          # 默认 http://127.0.0.1:8787/enroll
```

## 它提供什么

| 路径 | 说明 |
|---|---|
| `POST /v1/responses` | OpenAI Responses 协议，Codex（`wire_api = "responses"`）和其他客户端都走这个 |
| `POST /backend-api/codex/responses` | 同一个处理器的别名，给原生 CLI 的 `chatgpt_base_url` 用 |
| `GET /v1/models` | 返回 `GW_MODELS` 里配的模型列表 |
| `GET /enroll` | 自助授权页 |
| `GET /api/pool` | 池子现状（账号做过脱敏，key 不出现） |
| `GET /healthz` | 存活探针 |

注意：上游要求 `input` 必须是数组（`[{"type":"message",...}]`），传字符串会直接 400。
Codex 和 SDK 都发数组，手搓 curl 时容易踩。

## 同事怎么接入

打开 `/enroll` → 填名字 → 点「开始授权」→ 在新标签页里登录要上交的号、输入验证码 →
页面轮询到 token 后，后端把号写进池子，并给这个人发一把 `gw_` key（只显示一次）。

然后：

```toml
# ~/.codex/config.toml
model_provider = "gpt-gw"

[model_providers.gpt-gw]
name = "gpt-gw"
base_url = "http://gw.corp:8787/v1"
env_key = "GPT_GW_KEY"
wire_api = "responses"
```

```bash
export GPT_GW_KEY=gw_xxx
```

**授权成功后，建议本机不再 `codex login` 这个号。** 主要理由是请求会绕过网关：不粘连、
吃不到 prompt cache、额度也不进池子的账。两边同时刷新 refresh token 可能互相踢下线，
但这一点尚未实测（见下）。

## 网关内部怎么路由

- 入站 `Authorization: Bearer gw_xxx` → sha256 → 查 key → 得到 `person`
- `person` → 本周分配到的池账号（`assignments`，粘性）
- 出站换成该账号的 `access_token` + `ChatGPT-Account-Id`，POST 到
  `https://chatgpt.com/backend-api/codex/responses`，SSE 原样回流

几条硬约束，改代码时别破坏：

1. **一个号同时只能有一个刷新者。** 所有 refresh 走 `freshAccount()` 的进程内串行化，
   并且**先落盘新 refresh token，再用新 access token 发请求**。写失败就让这次请求失败。
2. **粘性优先。** `pickAccount()` 只有在号挂了（`status = dead`）或额度耗尽
   （`exhaustedUntil` 未到）时才重新分配，否则绝不动。动一次就丢一次 prompt cache。
3. **`store` 强制 false。** 池号是别人在用，不能把对话留在号主的历史里。
4. **429 才换号。** 收到 429 标记 `exhaustedUntil`（优先用 `retry-after`），重新分配后重试一次。

## device flow 的真实步骤（踩过的坑）

不是标准的 RFC 8628，是 OpenAI 自己改过的四步：

1. `POST /api/accounts/deviceauth/usercode`（`auth.openai.com`）→ `{device_auth_id, user_code, interval, expires_at}`
2. 人类在 `https://auth.openai.com/codex/device` 输码确认（**不是** `chatgpt.com/codex/device`，那个会跳回首页）
3. 轮询 `POST /api/accounts/deviceauth/token` → 未完成时是 `403` + `code: deviceauth_authorization_pending`；
   完成时**返回的不是 token**，而是 `{authorization_code, code_verifier, ...}`
4. 用 PKCE 换 token：`POST /oauth/token`，`application/x-www-form-urlencoded`：
   `grant_type=authorization_code&client_id=…&code=…&code_verifier=…&redirect_uri=https://auth.openai.com/deviceauth/callback`

`redirect_uri` 是**必需**的（漏了直接 400），值从 `https://auth.openai.com/codex/device` 的 302 跳转里能直接读出来。

## 已验证 / 未验证

**已实测通过（真实订阅号，2026-11-11）：**

- 网关转发 `POST /v1/responses` → 上游 200，SSE 正常回流，模型返回内容正确
- `x-oai-attestation` **不是必需的**：只带 `authorization` + `chatgpt-account-id` + `originator`
  就能打通，不需要伪造任何设备证明
- 模型目录来自 `GET /backend-api/codex/models?client_version=…`，按账号返回（实测 10 个），缓存 10 分钟
- **所有响应都要带 CORS 头**：Chatbox / ai-sdk 这类在渲染进程里 fetch 的客户端会先发 `OPTIONS`，
  且对 `GET /v1/models` 也做跨源校验。缺一个头就表现成“服务端 200、客户端一直重试”
- **可以用自己的身份**：`originator: gpt-gw` + `User-Agent: gpt-gw/0.1.0` 实测 200，
  不必冒充 `codex_cli_rs`。官方 CLI 的身份不是白名单
- workspace 级头：JWT 里的 `chatgpt_compute_residency`（本机账号值是 `no_constraint`）
  会作为 `x-openai-internal-codex-residency` 透传，缺了它某些 workspace 会 401
- 上游在响应头里直接给额度：`x-codex-primary-used-percent` / `x-codex-secondary-used-percent`
  （实测 primary=3、secondary=0），网关每次请求顺手采样，不用单独轮询 usage 接口

**还没做：**

- 周分配器（目前是「先到先得 + 最久未用」，单号时无感，多号后需要按 `usedPercent` 装箱）
- 429 换号、401 强制刷新这两条路径只有代码，没有真实触发过

**还没验：**

- device code 的完整闭环（卡在需要人工在 `auth.openai.com/codex/device` 输码）
- refresh token 轮转（测试号的 access token 还有 10 天，没触发刷新）

## 安全提醒

`data/state.json` 里是明文的 refresh token（文件权限 0600）。这台机器被拷走等于池子被端走。
上生产前至少做两件事：磁盘加密，或者把 `refreshToken` 字段换成 KMS/钥匙串加密后再落盘。

## 故障注入与诊断

默认不挂载，只有 `GW_DEBUG=1` 时才有：

```bash
GW_DEBUG=1 node src/server.mjs
curl -X POST localhost:8788/api/debug/fault -d '{"status":429,"headers":{"retry-after":"3"},"body":{"error":{"message":"x"}}}'
curl -X POST localhost:8788/api/debug/fault -d '{"clear":true}'
```

429 没法诚实地触发（除非真把额度烧光），所以控制流只能靠注入验证。**注入不等于上游语义**——
真实 429 的 header 和 body 形状，只能等它发生。为此上游每个非 2xx 都会追加到
`data/upstream-errors.jsonl`：状态码、`retry-after`、所有 `x-codex-*` 头、body 前 800 字。

401 可以真触发：停服务 → 把 `state.json` 里某个号的 `accessToken` 改成任意字符串
（`expiresAt` 保持未来）→ 启服务 → 发请求。三种终态：

| 情况 | 结果 |
|---|---|
| access 坏、refresh 好 | 200，静默刷新（refresh token 会轮转） |
| 号彻底死 | 200，re-pin 到别的号 |
| 池子全空 | 503 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GW_HOST` / `GW_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `GW_DATA_DIR` | `./data` | 状态目录（`state.json`，0600） |
| `GW_CHATGPT_BASE` | `https://chatgpt.com` | 上游 |
| `GW_AUTH_BASE` | `https://auth.openai.com` | OAuth |
| `GW_MODELS` | `gpt-6-astra` | 模型目录拉取失败时的兜底列表 |
| `GW_CLIENT_LABEL` | `gpt-gw` | 上游身份：originator 与 UA 的前缀 |
| `GW_ORIGINATOR` | 同 `GW_CLIENT_LABEL` | 单独覆盖 `originator` 头 |
| `GW_CLIENT_UA` | `<label>/0.1.0` | 单独覆盖 `User-Agent` |
| `GW_FORCE_STORE_FALSE` | `1` | 设 `0` 关闭强制 |
| `GW_EXHAUST_COOLDOWN_MS` | `900000` | 429 后冷却时长 |

## 目录

```
src/openai.mjs   上游协议（deviceauth / oauth refresh / id_token 解析）
src/store.mjs    状态（账号、key、分配），原子写
src/forward.mjs  转发、续期、换号、SSE
src/server.mjs   HTTP 路由 + 授权会话
src/page.mjs     自助授权页
```
