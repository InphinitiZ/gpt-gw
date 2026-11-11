// 所有对 OpenAI 上游的调用集中在这里。端点来自 codex-cli 0.163.0 二进制里的字符串，
// 换 CLI 版本时只需要改这个文件。

const CLIENT_ID = process.env.GW_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = process.env.GW_AUTH_BASE ?? 'https://auth.openai.com'
const CHATGPT_BASE = process.env.GW_CHATGPT_BASE ?? 'https://chatgpt.com'
const CODEX_UA = process.env.GW_CODEX_UA ?? 'codex_cli_rs/0.163.0'

// 模仿官方客户端的请求形态。deviceauth 端点有 Cloudflare 机器人策略，
// 出口 IP 不干净时会直接返回 403 HTML 挑战页而不是 JSON。
const BASE_HEADERS = {
  'content-type': 'application/json',
  'user-agent': CODEX_UA,
  originator: 'codex_cli_rs',
}

export class UpstreamError extends Error {
  constructor(status, body) {
    super(`upstream ${status}`)
    this.status = status
    this.body = body
    this.challenge = isCloudflareChallenge(body)
  }
}

function isCloudflareChallenge(body) {
  return typeof body === 'string' && body.includes('Just a moment')
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON，多半是 CF 挑战页或 HTML 错误页 */
  }
  if (!res.ok) throw new UpstreamError(res.status, json ?? text.slice(0, 400))
  return json
}

export async function startDeviceCode() {
  const json = await postJson(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID })
  const expiresAt = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 900_000
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    verificationUri: `${AUTH_BASE}/codex/device`,
    intervalSec: Number(json.interval ?? 5),
    expiresInSec: Math.max(30, Math.round((expiresAt - Date.now()) / 1000)),
  }
}

export async function pollDeviceCode(deviceAuthId, userCode) {
  try {
    const json = await postJson(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
      client_id: CLIENT_ID,
      device_auth_id: deviceAuthId,
      user_code: userCode,
    })
    // 注意：这一步返回的不是 token，而是 authorization_code + code_verifier，
    // 还要再换一次 /oauth/token。只在真的带了 access_token 时才当 token 用。
    return { status: 'complete', payload: json }
  } catch (err) {
    if (err instanceof UpstreamError && typeof err.body === 'object' && err.body) {
      const code = String(err.body?.error?.code ?? '')
      if (code.includes('authorization_pending')) return { status: 'pending' }
      if (code.includes('slow_down')) return { status: 'pending', slowDown: true }
      if (code.includes('expired_token') || code.includes('expired')) return { status: 'expired' }
      if (code.includes('access_denied') || code.includes('denied')) return { status: 'denied' }
    }
    throw err
  }
}

// device 流程拿到 authorization_code 后，用 PKCE 换真正的 token。
// redirect_uri 在文档里没有，只能按可能性依次试；失败信息全部带回去。
export async function exchangeDeviceCode({ code, codeVerifier }) {
  const candidates = [
    `${AUTH_BASE}/deviceauth/callback`,
    'http://localhost:1455/auth/callback',
    `${AUTH_BASE}/auth/callback`,
    null,
  ]
  const failures = []
  for (const redirectUri of candidates) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
    })
    if (redirectUri) form.set('redirect_uri', redirectUri)

    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': CODEX_UA,
        originator: 'codex_cli_rs',
      },
      body: form,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    if (res.ok) return JSON.parse(text)
    failures.push(`${redirectUri ?? '(无 redirect_uri)'} → ${res.status} ${text.slice(0, 200)}`)
  }
  const err = new Error(`token exchange 全部失败: ${failures.join(' ｜ ')}`)
  err.exchangeFailures = failures
  throw err
}

export async function refreshTokens(refreshToken) {
  const json = await postJson(`${AUTH_BASE}/oauth/token`, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    idToken: json.id_token ?? null,
    expiresIn: Number(json.expires_in ?? 3600),
  }
}

// id_token / access_token 都是 JWT，账号 id 藏在 `https://api.openai.com/auth`
// 这个自定义 claim 里。device flow 拿到的 token 集合结构和浏览器登录不完全一样，
// 所以这里放宽：任意一个 token 里找到就算数。
export function claimsOf(jwt) {
  if (typeof jwt !== 'string' || !jwt.includes('.')) return null
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export function extractAccountId(...tokens) {
  for (const token of tokens) {
    const claims = claimsOf(token)
    if (!claims) continue
    const auth = claims['https://api.openai.com/auth'] ?? {}
    const id = auth.chatgpt_account_id ?? claims.chatgpt_account_id ?? claims.account_id
    if (id) return id
  }
  return null
}

export function extractEmail(...tokens) {
  for (const token of tokens) {
    const claims = claimsOf(token)
    if (claims?.email) return claims.email
  }
  return null
}

// 出问题时把结构（只有键名，没有值）留下来，避免再让用户重来一次
export function describeTokenShape(body) {
  const keys = Object.keys(body ?? {})
  const describe = (jwt) => {
    const claims = claimsOf(jwt)
    if (!claims) return { jwt: false }
    const auth = claims['https://api.openai.com/auth']
    return {
      jwt: true,
      top_level_keys: Object.keys(claims),
      auth_claim_keys: auth ? Object.keys(auth) : null,
    }
  }
  return {
    response_keys: keys,
    id_token: describe(body?.id_token),
    access_token: describe(body?.access_token),
    refresh_token_present: Boolean(body?.refresh_token),
  }
}

export async function fetchCodexModels(accessToken, accountId) {
  const version = process.env.GW_CLIENT_VERSION ?? '0.163.0'
  const res = await fetch(`${CHATGPT_BASE}/backend-api/codex/models?client_version=${version}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      originator: 'codex_cli_rs',
      'user-agent': CODEX_UA,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) throw new UpstreamError(res.status, text.slice(0, 400))
  const json = JSON.parse(text)
  return (json.models ?? []).map((m) => m.slug).filter(Boolean)
}

// 额度探针：base 去掉 /codex 后拼 /wham/usage（跟 Codex CLI 的 PathStyle 一致）
export function usageUrl(base = `${CHATGPT_BASE}/backend-api/codex`) {
  return base.replace(/\/codex\/?$/, '') + '/wham/usage'
}

export async function fetchUsage(accessToken, accountId, { base } = {}) {
  const res = await fetch(usageUrl(base), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      originator: 'alpha-mind',
      'user-agent': CODEX_UA,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) throw new UpstreamError(res.status, safeJson(text) ?? text.slice(0, 300))
  return extractQuota(safeJson(text) ?? {})
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// 形如 { rate_limit: { primary_window: { used_percent }, secondary_window: {...} } }
export function extractQuota(payload) {
  const quota = {}
  const windows = [payload.rate_limit ?? {}, ...(payload.additional_rate_limits ?? []).map((x) => x?.rate_limit ?? {})]
  const pick = (name) => {
    let used = null
    let resetAfter = null
    for (const w of windows) {
      const win = w[name]
      if (!win) continue
      if (typeof win.used_percent === 'number') used = Math.max(used ?? 0, win.used_percent)
      if (typeof win.reset_after_seconds === 'number') resetAfter = win.reset_after_seconds
    }
    return used === null && resetAfter === null ? null : { usedPercent: used, resetAfterSec: resetAfter }
  }
  const primary = pick('primary_window')
  const secondary = pick('secondary_window')
  if (primary) quota.primary = primary
  if (secondary) quota.secondary = secondary
  return Object.keys(quota).length ? quota : null
}

// 撤销一路授权。注意实测：这个接口是按用户撤销的，会把该账号所有设备的会话一起作废。
export async function revokeToken(refreshToken) {
  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: 'refresh_token',
    client_id: CLIENT_ID,
  })
  const res = await fetch(`${AUTH_BASE}/oauth/revoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      originator: 'alpha-mind',
      'user-agent': CODEX_UA,
    },
    body,
    signal: AbortSignal.timeout(20000),
  })
  return { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 200) }
}

export const upstream = { AUTH_BASE, CHATGPT_BASE, CLIENT_ID }
