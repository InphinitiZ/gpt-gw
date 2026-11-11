# alpha-mind

ChatGPT 订阅号共享网关（仓库目录仍叫 `gpt-gw`）。

把公司报销的 ChatGPT 订阅号做成一个共享池，让 Codex 这类客户端用**标准 API key** 接入。
同事不需要登录 ChatGPT，只需要一个网关发的 `gw_` key。

> ⚠️ 这套做法不在 OpenAI 的授权范围内，和官方合作方模式有本质区别。
> 上线前先读[风险与合规](#风险与合规)。

零依赖，Node ≥ 20 直接跑。

```bash
node src/server.mjs          # 默认 http://127.0.0.1:8787/ ，可用 GW_PORT 改
```

## 风险与合规

**先说清楚：这套东西技术上可行，但不在 OpenAI 的授权范围内。** 用之前要知道自己在做什么。

### 官方其实有一条路

2026-09-29，OpenAI 推出 “Sign in with ChatGPT”：订阅额度可以在 **16 个合作 app** 里使用，
按“每周额度的一个百分比”给每个 app 设上限，用掉的量算在订阅者自己的额度里。
[Hermes Agent 就在合作名单里](https://learn.chatgpt.com/docs/sign-in-with-chatgpt#partners)，
规则细节见[这篇报道](https://mixed-news.com/en/chatgpt-plus-allowance-16-partner-apps-no-api-key/)。

所以 Hermes 能用订阅额度，靠的是**合作资格**，不是那套设备码登录的技术。技术我们也有，
而且已经跑通——差别在谁花谁的额度。

### 我们和官方模式的区别

| | 合作方（Hermes 等） | 本网关 |
|---|---|---|
| 账号 | 登录者本人的号 | 一个号服务多个人 |
| 额度归属 | 花登录者自己的额度 | Alice 的请求可能花 Bob 的额度 |
| 出口 | 用户各自的网络 | 所有账号共用一个出口 IP |

第三条最容易出事：官方模式下每个用户的流量和他的日常使用没有区别；这里 N 个账号的流量
从同一台机器出去，“这些账号共用一个出口”本身就是可识别的信号。平台有能力把同一 IP
关联到多个账号，也能看出某个号的用量从“一个人”变成“三个人”。

### 已经做的降信号设计

- 自己的号优先，用完才借别人的，不主动跨账号分摊
- 借号后粘住不来回跳，让每个号的流量看起来连续
- `originator` 用 `alpha-mind` 自己的名字，不冒充 `codex_cli_rs`
- `store: false`，不往号主的历史里写对话
- 退出不调 revoke（实测会登出该账号全部设备），不惊动号主其它登录

这些能压低信号，**不能消除风险**。真要降低，最有效也最便宜的一步是：
**把网关跑在办公网，不要放云主机**——让出口 IP 和团队日常使用混在一起，
而不是一整个机房 IP 驱动所有账号。

### 合规的替代路径

- 同事各自用那 16 个合作 app 里的某一个（Hermes、Warp、Vercel 等），登自己的号，额度各归各的
- 换 ChatGPT Business / Enterprise 席位，用工作区级额度

两条都不需要维护账号池，代价是“打不满”。这是产品决策，不是技术问题。

## 它提供什么

| 路径 | 说明 |
|---|---|
| `POST /v1/responses` | OpenAI Responses 协议，Codex（`wire_api = "responses"`）和其他客户端都走这个 |
| `POST /backend-api/codex/responses` | 同一个处理器的别名，给原生 CLI 的 `chatgpt_base_url` 用 |
| `GET /v1/models` | 从池账号实时拉上游模型目录（缓存 10 分钟，失败回退 `GW_MODELS`） |
| `GET /` | 按登录态分流：落地页 / 302 到 `/me` |
| `GET /enroll` | 授权页 |
| `GET /me` | 个人面板 |
| `GET /admin` | 管理台 |
| `GET /api/pool` | 池子现状（账号脱敏，key 不出现） |
| `GET /healthz` | 存活探针 |

注意：上游要求 `input` 必须是数组（`[{"type":"message",...}]`），传字符串会直接 400。
Codex 和 SDK 都发数组，手搓 curl 时容易踩。

## 入口

| 路径 | 行为 |
|---|---|
| `/` | 已登录 → 302 到 `/me`；未登录 → 落地页（key 登录 / 新用户交号） |
| `/me` | 个人面板：托管的号、用量、退出申请、**加一个号**、死号的**重新授权** |
| `/enroll` | 授权流程；已登录时自动挂到当前身份下 |
| `/admin` | 管理台 |

号坏了（`status = dead`）不需要重新走注册流程：在 `/me` 点「重新授权」重跑一次设备授权，
系统按 `accountId` 命中同一条记录并刷新凭据，身份和 key 都不变。

## 页面上也有说明

`/enroll` 成功页和 `/me` 的「如何使用」里都有一份接入说明：端点、Codex `config.toml`、
Chatbox 四个字段、curl 示例，以及三个坑（`input` 必须是数组、`store` 被强制 false、
模型以 `/v1/models` 为准）。说明里的地址取自 `location.origin`，key 在 enroll 页自动填真值，
在 `/me` 里是占位符（key 只存哈希，取不回来）。

## 同事怎么接入

打开 `/enroll` → 填名字 → 点「开始授权」→ 在新标签页里登录要上交的号、输入验证码 →
页面轮询到 token 后，后端把号写进池子，并给这个人发一把 `gw_` key（只显示一次）。

然后：

```toml
# ~/.codex/config.toml
model_provider = "alpha-mind"

[model_providers.alpha-mind]
name = "alpha-mind"
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
- `person` → 池账号（`assignments`，粘性），选择顺序：
  1. **自己的号**（`reason = own`）——托管的号优先自己用
  2. 自己的号耗尽/失效才借别人的（`reason = spill`），借上之后粘住
  3. 自己的号恢复（续期、周额度重置）后自动回到自己家
  4. 池子里没有可用号 → 503
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

- device code 四步闭环：申请码 → 人工输码 → 拿 `authorization_code` → PKCE 换 token
- 网关转发 `POST /v1/responses` → 上游 200，SSE 正常回流，模型输出正确
- `x-oai-attestation` **不是必需的**；`originator` 可以用自己的名字
- 401 三种终态：access 坏但 refresh 好（静默刷新）、号彻底死（换号）、池子全空（503）
- 429 控制流：注入验证（冷却、透传、恢复）；**真实 429 的语义仍未见过**
- 额度探针：`/wham/usage` 真实返回，`primary_window.used_percent` / `limit_reached` /
  `reset_at` / `credits` 全部解析正确
- refresh token 单次使用、轮转后必须立刻落盘
- `revoke` 按**用户**生效：一次调用会登出该账号所有设备（这是「退出不 revoke」的原因）
- 模型目录：`/backend-api/codex/models` 按账号返回 10 个模型

**还没做：**

- 周分配器：多号时仍是「自己的号优先 + 最久未用兜底」，没有按余量装箱
- 重复身份合并：cookie 和 key 都丢了的人重新 enroll 会产生新身份，后台出现同名两行
- refresh token 明文存储在 `data/state.json`（0600，但未加密）
- 真实 429 的形状（只有注入验证，没见过上游真实响应）

## 安全提醒

`data/state.json` 里是明文的 refresh token（文件权限 0600）。这台机器被拷走等于池子被端走。
上生产前至少做两件事：磁盘加密，或者把 `refreshToken` 字段换成 KMS/钥匙串加密后再落盘。

## 身份与归属规则

- **一个人 = 一个随机 id（`p_xxxx`）+ 一把 key**。名字只是显示名，**允许重名**，
  不参与任何判断——同名不会串号，也不会被“占名”。
- key 在首次 enroll 时创建，之后追加账号**沿用原 key**，不会换新。
  要加号请先 `POST /api/login` 用 key 登录，页面会自动把新号挂到同一个身份下。
- 代价：如果浏览器 cookie 丢了又没有 key，重新 enroll 会造出一个**新身份**（同名不同 id），
  后台看到两行同名记录。目前没有合并功能，只能让管理员人工辨认（按 ChatGPT 邮箱）。
- **一个 ChatGPT 账号只能有一个托管人**。同号被别人再次 enroll 会被拒绝，
  换人必须先让原托管人走退出流程。
- 一个人可以托管多个号，`/api/me` 返回 `accounts[]`，路由时优先用他自己的任意可用号。
- **退出某个号 ≠ 退出整个托管**：只要还剩一个号在池里，key 保留；退到零个才撤销 key、
  清掉会话和 `people` 记录——也就是这个人在系统里彻底消失。
- 管理员「强制撤销」走同一条规则：撤掉最后一个号时，key 一并撤销。
- 账号只是 `dead`（还能重新授权）不算退出，key 保留。
- 退出后不留历史记录；用同一个名字重新 enroll 时如果名字已被另一个人占用，只能换个名字。

## 退出托管与撤销

**退出托管不碰上游授权。** 批准后只做三件事：摘号、撤销该人的 key 和会话、结束申请单。
理由：实测 `POST /oauth/revoke` 是**按用户**撤销的，一次调用会让该账号在所有设备上的登录全部失效
（refresh 返回 `refresh_token_invalidated`，access 返回 `token_revoked`）。对一次普通「退出」来说破坏力过大。

真要终止授权，走管理员的**强制撤销**：调上游 revoke + 摘号，并明确告知会登出该账号所有设备。
即使 revoke 失败也照样摘号——留着我们不再管理的凭据没有意义。

## 存活与额度探针

每 10 分钟（`GW_PROBE_INTERVAL_MS`）对每个非 `dead` 账号打一次 `GET /backend-api/wham/usage`：

| 返回 | 判定 | 动作 |
|---|---|---|
| 200 | 正常 | 更新 `used_percent` |
| 401 `token_expired` | access 过期 | 强刷后重试一次 |
| 401 其他 / 刷新失败 | 已撤销 | 标记 `dead` |
| 429 | 额度耗尽 | 冷却 |

这样没人发请求时也能在 10 分钟内发现号挂了。账号状态机：`ok / dead / exhausted / unknown`。

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
| `GW_CLIENT_LABEL` | `alpha-mind` | 上游身份：originator 与 UA 的前缀 |
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
