import { Readable } from 'node:stream'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { refreshTokens, extractAccountId, claimsOf, UpstreamError, upstream } from './openai.mjs'
import { pickAccount, updateAccount } from './store.mjs'

// 同一个号并发刷新会互相踢下线：所有刷新必须串行化。
const refreshing = new Map()

// 故障注入：只用于验证 429/401 的控制流，不代表上游真实语义。
const faults = new Map()

export function setFault(accountId, fault) {
  faults.set(accountId ?? '*', fault)
}

export function clearFaults() {
  faults.clear()
}

// 上游每次非 2xx 都留档，这样第一次真实 429 就能看到它的真实形状
function recordUpstreamError(account, status, body, headers) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      account: account.id,
      status,
      retry_after: headers?.get?.('retry-after') ?? null,
      quota_headers: headers ? Object.fromEntries([...headers].filter(([k]) => k.startsWith('x-codex-'))) : null,
      body: String(body ?? '').slice(0, 800),
    })
    appendFileSync(resolve(process.env.GW_DATA_DIR ?? './data', 'upstream-errors.jsonl'), line + '\n')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

const FORCE_STORE_FALSE = process.env.GW_FORCE_STORE_FALSE !== '0'
const EXHAUST_COOLDOWN_MS = Number(process.env.GW_EXHAUST_COOLDOWN_MS ?? 15 * 60 * 1000)

function openaiError(message, type = 'gateway_error', code = null) {
  return { error: { message, type, code, param: null } }
}

// 上游把额度用量直接放在响应头里：x-codex-primary-used-percent 之类。
// 这比单独轮询 usage 接口省事，每个真实请求自带一次采样。
function quotaFromHeaders(headers) {
  const quota = {}
  for (const [name, value] of headers) {
    const used = /^x-codex-([a-z0-9-]+)-used-percent$/.exec(name)
    if (used) {
      quota[used[1]] ??= {}
      quota[used[1]].usedPercent = Number(value)
      continue
    }
    const reset = /^x-codex-([a-z0-9-]+)-reset-after$/.exec(name)
    if (reset) {
      quota[reset[1]] ??= {}
      quota[reset[1]].resetAfterSec = Number(value)
    }
  }
  return Object.keys(quota).length ? quota : null
}

// 兜底：账号记录里没存 account id 时，直接从 access token 的 claim 里推
function ensureAccountId(account) {
  if (account.accountId) return account
  const id = extractAccountId(account.accessToken)
  if (!id) return account
  updateAccount(account.id, { accountId: id })
  return { ...account, accountId: id }
}

export async function freshAccount(account, { force = false } = {}) {
  const now = Date.now()
  const stillValid = account.accessToken && account.expiresAt && account.expiresAt - now > 5 * 60 * 1000
  if (stillValid && !force) return account

  const inflight = refreshing.get(account.id)
  if (inflight) return inflight

  const task = (async () => {
    const rotated = await refreshTokens(account.refreshToken)
    const patch = {
      accessToken: rotated.accessToken,
      expiresAt: now + rotated.expiresIn * 1000,
      status: 'ok',
    }
    if (rotated.refreshToken) patch.refreshToken = rotated.refreshToken
    // 先落盘，再拿新 token 去发请求。写失败必须让这次请求失败。
    updateAccount(account.id, patch)
    return { ...account, ...patch }
  })()

  refreshing.set(account.id, task)
  try {
    return await task
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) {
      // refresh token 已经死了，这个号没救了
      updateAccount(account.id, { status: 'dead' })
    }
    throw err
  } finally {
    refreshing.delete(account.id)
  }
}

// 身份头。官方客户端用 codex_cli_rs，某些第三方 harness 用自己的名字也能通过，
// 用自己的名字比冒充官方客户端干净（风控画像更真实）。
const CLIENT_LABEL = process.env.GW_CLIENT_LABEL ?? 'gpt-gw'
const ORIGINATOR = process.env.GW_ORIGINATOR ?? CLIENT_LABEL
const CLIENT_UA = process.env.GW_CLIENT_UA ?? `${CLIENT_LABEL}/0.1.0`

// workspace 级要求：部分账号在 JWT 里带 residency，不带这个头会 401
// "Workspace is not authorized in this region"。
function residencyOf(account) {
  try {
    const claims = claimsOf(account.accessToken) ?? {}
    const auth = claims['https://api.openai.com/auth'] ?? {}
    return auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency ?? null
  } catch {
    return null
  }
}

function upstreamHeaders(account, clientHeaders, streaming) {
  const headers = {
    authorization: `Bearer ${account.accessToken}`,
    'chatgpt-account-id': account.accountId,
    'content-type': 'application/json',
    accept: streaming ? 'text/event-stream' : 'application/json',
    originator: ORIGINATOR,
    'user-agent': CLIENT_UA,
  }
  const residency = residencyOf(account)
  if (residency) headers['x-openai-internal-codex-residency'] = residency
  if (process.env.GW_DEBUG === '1') {
    console.log(`upstream identity originator=${ORIGINATOR} ua=${CLIENT_UA} residency=${residency ?? '(none)'}`)
  }
  // 这些头是 Codex 自己的会话/续传语义，原样透传，网关不解读
  for (const name of [
    'session_id',
    'conversation_id',
    'x-client-request-id',
    'x-codex-turn-state',
    'x-codex-window-id',
    'x-codex-routing-hint',
    'openai-beta',
    'accept-language',
  ]) {
    const value = clientHeaders[name]
    if (value) headers[name] = value
  }
  return headers
}

async function callUpstream(account, payload, streaming, clientHeaders) {
  return fetch(`${upstream.CHATGPT_BASE}/backend-api/codex/responses`, {
    method: 'POST',
    headers: upstreamHeaders(account, clientHeaders, streaming),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.GW_UPSTREAM_TIMEOUT_MS ?? 900_000)),
  })
}

async function sendError(res, status, body) {
  if (res.headersSent) return res.end()
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/**
 * 把一次 Responses 请求转给某个池账号，处理续期、耗尽换号和 401 重试。
 * @returns {Promise<void>}
 */
export async function proxyResponses(req, res, person, rawBody) {
  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return sendError(res, 400, openaiError('body 不是合法 JSON', 'invalid_request_error'))
  }

  // 有的客户端把 input 发成字符串，上游只认数组，这里统一兜一下
  if (typeof payload.input === 'string') {
    payload.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: payload.input }] }]
  }

  if (FORCE_STORE_FALSE) payload.store = false

  const streaming = payload.stream !== false
  let { account } = pickAccount(person)
  if (!account) return sendError(res, 503, openaiError('池里没有可用账号', 'insufficient_quota'))
  if (!payload.model && account.defaultModel) payload.model = account.defaultModel

  let attempt = 0
  let lastStatus = 0
  let lastBody = null

  while (attempt < 2) {
    attempt += 1
    try {
      account = ensureAccountId(await freshAccount(account, { force: lastStatus === 401 }))
    } catch (err) {
      // 续期失败时这个号已经被标死，换一个；没有别的号就是“池子空了”，不是上游 502
      const repick = pickAccount(person)
      if (repick.account && repick.account.id !== account.id) {
        account = repick.account
        continue
      }
      return sendError(res, 503, openaiError(`池里没有可用账号（续期失败: ${err.message}）`, 'insufficient_quota'))
    }

    let upstreamRes
    const fault = faults.get(account.id) ?? faults.get('*')
    if (fault) {
      upstreamRes = new Response(JSON.stringify(fault.body ?? {}), {
        status: fault.status,
        headers: { 'content-type': 'application/json', ...(fault.headers ?? {}) },
      })
    } else {
      try {
        upstreamRes = await callUpstream(account, payload, streaming, req.headers)
      } catch (err) {
        return sendError(res, 504, openaiError(`上游不可达: ${err.message}`, 'gateway_error'))
      }
    }

    lastStatus = upstreamRes.status

    const quota = quotaFromHeaders(upstreamRes.headers)
    if (quota) updateAccount(account.id, { quota, quotaAt: Date.now() })

    if (!upstreamRes.ok) recordUpstreamError(account, upstreamRes.status, await upstreamRes.clone().text(), upstreamRes.headers)

    if (upstreamRes.status === 401) {
      lastBody = await upstreamRes.text()
      if (attempt === 1) continue // 强制刷新后重试
      return sendError(res, 401, openaiError('上游拒绝了这个号的凭据', 'invalid_api_key'))
    }

    if (upstreamRes.status === 429) {
      lastBody = await upstreamRes.text()
      const retryAfter = Number(upstreamRes.headers.get('retry-after')) * 1000
      updateAccount(account.id, {
        exhaustedUntil: Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : EXHAUST_COOLDOWN_MS),
      })
      if (attempt === 1) {
        const repick = pickAccount(person)
        if (repick.account && repick.account.id !== account.id) {
          account = repick.account
          continue
        }
      }
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
      return res.end(lastBody || JSON.stringify(openaiError('额度耗尽', 'insufficient_quota')))
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      })
      return res.end(text)
    }

    updateAccount(account.id, { lastUsedAt: Date.now(), status: 'ok' })

    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? (streaming ? 'text/event-stream' : 'application/json'),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-gw-account, x-gw-person',
      'x-gw-account': account.id,
      'x-gw-person': encodeURIComponent(person),
    })

    if (!upstreamRes.body) return res.end()
    Readable.fromWeb(upstreamRes.body).pipe(res)
    return
  }

  return sendError(res, 502, { ...openaiError('上游连续失败'), upstream: String(lastBody ?? '').slice(0, 500) })
}
