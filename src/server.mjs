import { createServer } from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { enrollPage } from './page.mjs'
import { startDeviceCode, pollDeviceCode, exchangeDeviceCode, extractAccountId, extractEmail, describeTokenShape, fetchCodexModels, UpstreamError } from './openai.mjs'
import {
  addAccount, rotateKey, listAccounts, listKeys, keyByHash, saveDiagnostic, anyHealthyAccount, flush,
} from './store.mjs'
import { proxyResponses, freshAccount, setFault, clearFaults } from './forward.mjs'

const HOST = process.env.GW_HOST ?? '127.0.0.1'
const PORT = Number(process.env.GW_PORT ?? 8787)
const SESSION_TTL_MS = 15 * 60 * 1000

/** @type {Map<string, any>} */
const sessions = new Map()

// Chatbox 这类 Electron 客户端的 fetch 仍然受同源策略约束，会先发 OPTIONS 预检。
// 不处理预检就会表现成“网络连接失败”。
function corsHeaders(req) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      req.headers['access-control-request-headers'] ?? 'authorization, content-type, x-api-key',
    'access-control-max-age': '86400',
    'access-control-expose-headers': 'x-gw-account, x-gw-person, x-request-id',
  }
}

function json(res, status, body, req) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(req ? corsHeaders(req) : {}),
  })
  res.end(payload)
}

async function readBody(req, limit = 16 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex')
}

function authenticate(req) {
  const header = req.headers['authorization'] ?? ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const key = raw || String(req.headers['x-api-key'] ?? '').trim()
  if (!key) return null
  return keyByHash(hashKey(key))
}

async function readRaw(req, limit = 64 * 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function newSession(name) {
  const sid = randomUUID()
  const session = {
    sid,
    name,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    status: 'pending',
    deviceAuthId: null,
    userCode: null,
    verificationUri: null,
    intervalSec: 5,
    result: null,
    error: null,
  }
  sessions.set(sid, session)
  return session
}

function failSession(session, message, challenge = false) {
  session.status = 'error'
  session.error = { message, challenge }
}

async function handleStart(req, res) {
  const body = await readBody(req)
  const name = String(body.name ?? '').trim()
  if (!name) return json(res, 400, { message: '缺少 name' })

  const session = newSession(name)
  try {
    const device = await startDeviceCode()
    session.deviceAuthId = device.deviceAuthId
    session.userCode = device.userCode
    session.verificationUri = device.verificationUri
    session.intervalSec = device.intervalSec
    return json(res, 200, {
      sid: session.sid,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSec: device.intervalSec,
      expiresInSec: device.expiresInSec,
    })
  } catch (err) {
    if (err instanceof UpstreamError) {
      const challenge = err.challenge || err.status === 403
      failSession(session, challenge ? 'Cloudflare 拦截了网关发起的设备授权请求' : `上游返回 ${err.status}`, challenge)
      return json(res, 502, { status: 'error', ...session.error })
    }
    failSession(session, String(err?.message ?? err))
    return json(res, 500, { status: 'error', ...session.error })
  }
}

async function handleStatus(req, res, url) {
  const sid = url.searchParams.get('sid')
  const session = sid ? sessions.get(sid) : null
  if (!session) return json(res, 404, { status: 'error', message: '会话不存在或已过期' })

  if (session.status === 'error') return json(res, 200, { status: 'error', ...session.error })
  if (session.status === 'complete') return json(res, 200, { status: 'complete', ...session.result })
  if (Date.now() > session.expiresAt) {
    failSession(session, '验证码已过期，重新来一次')
    return json(res, 200, { status: 'error', ...session.error })
  }

  try {
    const poll = await pollDeviceCode(session.deviceAuthId, session.userCode)
    if (poll.status === 'pending') {
      return json(res, 200, { status: 'pending' })
    }
    if (poll.status === 'expired') {
      failSession(session, '验证码已过期，重新来一次')
      return json(res, 200, { status: 'error', ...session.error })
    }
    if (poll.status === 'denied') {
      failSession(session, '授权被拒绝')
      return json(res, 200, { status: 'error', ...session.error })
    }

    // device 流程两步走：先拿 authorization_code，再用 PKCE 换 token
    let tokens = poll.payload?.access_token ? (poll.payload.tokens ?? poll.payload) : null
    if (!tokens) {
      const authorizationCode = poll.payload?.authorization_code
      const codeVerifier = poll.payload?.code_verifier
      if (!authorizationCode || !codeVerifier) {
        saveDiagnostic(describeTokenShape(poll.payload))
        failSession(session, '授权成功但响应里既没有 token 也没有 authorization_code，结构已留档')
        return json(res, 200, { status: 'error', ...session.error })
      }
      try {
        tokens = await exchangeDeviceCode({ code: authorizationCode, codeVerifier })
      } catch (err) {
        saveDiagnostic({
          phase: 'exchange',
          payload_keys: Object.keys(poll.payload ?? {}),
          failures: err.exchangeFailures ?? [err.message],
        })
        failSession(session, `换 token 失败：${err.message}`)
        return json(res, 200, { status: 'error', ...session.error })
      }
    }

    const accountId = extractAccountId(tokens.id_token, tokens.access_token)
    if (!accountId) {
      // 授权是一次性的人工动作，不能因为解析失败就扔掉。先入库，结构留档，回头修解析。
      saveDiagnostic(describeTokenShape(tokens))
    }
    if (!tokens.refresh_token) {
      saveDiagnostic({ ...describeTokenShape(tokens), phase: 'missing-refresh-token' })
      failSession(session, '换到了 token 但没有 refresh_token，结构已留档')
      return json(res, 200, { status: 'error', ...session.error })
    }

    const email = extractEmail(tokens.id_token, tokens.access_token)
    const { account, created } = addAccount({
      owner: session.name,
      email,
      accountId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    })

    const plaintextKey = `gw_${randomBytes(24).toString('hex')}`
    rotateKey({ hash: hashKey(plaintextKey), person: session.name, accountId })

    session.status = 'complete'
    session.result = {
      key: plaintextKey,
      account: {
        id: account.id,
        label: account.label,
        email: account.email,
        accountId: account.accountId ? account.accountId.slice(0, 4) + '…' + account.accountId.slice(-4) : null,
        accountIdResolved: Boolean(account.accountId),
        created,
      },
    }
    return json(res, 200, { status: 'complete', ...session.result })
  } catch (err) {
    if (err instanceof UpstreamError) {
      const challenge = err.challenge || err.status === 403
      failSession(session, challenge ? 'Cloudflare 拦截了网关的轮询请求' : `上游返回 ${err.status}`, challenge)
      return json(res, 200, { status: 'error', ...session.error })
    }
    failSession(session, String(err?.message ?? err))
    return json(res, 200, { status: 'error', ...session.error })
  }
}

let modelCache = { at: 0, ids: null }

async function codexModelIds() {
  if (modelCache.ids && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.ids
  const fallback = (process.env.GW_MODELS ?? 'gpt-6-astra').split(',').map((s) => s.trim()).filter(Boolean)
  const account = anyHealthyAccount()
  if (!account) return fallback
  try {
    const fresh = await freshAccount(account)
    const ids = await fetchCodexModels(fresh.accessToken, fresh.accountId)
    if (ids.length) {
      modelCache = { at: Date.now(), ids }
      return ids
    }
  } catch (err) {
    console.warn('模型目录拉取失败，用兜底列表:', err.message)
  }
  return fallback
}

const DEBUG = process.env.GW_DEBUG === '1'

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  // 所有响应统一带上 CORS，否则跨源 GET（拉模型列表）会被浏览器层拦掉，
  // 表现为客户端一直重试。
  for (const [name, value] of Object.entries(corsHeaders(req))) res.setHeader(name, value)

  if (url.pathname !== '/healthz') {
    const t0 = Date.now()
    res.on('finish', () => {
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 28)
      console.log(`${req.method} ${url.pathname} → ${res.statusCode} ${Date.now() - t0}ms ua=${ua}`)
    })
  }

  try {
    // 只在 GW_DEBUG=1 时挂载，用来验证 429/401 分支
    if (DEBUG && req.method === 'POST' && url.pathname === '/api/debug/fault') {
      const body = await readBody(req)
      if (body.clear) {
        clearFaults()
        return json(res, 200, { ok: true, cleared: true })
      }
      setFault(body.accountId ?? '*', {
        status: Number(body.status ?? 429),
        headers: body.headers ?? {},
        body: body.body ?? {},
      })
      return json(res, 200, { ok: true, fault: { status: body.status, headers: body.headers } })
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req))
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, accounts: listAccounts().length, keys: listKeys().length })
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/enroll')) {
      const html = enrollPage()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }
    if (req.method === 'POST' && url.pathname === '/api/enroll/start') return await handleStart(req, res)
    if (req.method === 'GET' && url.pathname === '/api/enroll/status') return await handleStatus(req, res, url)
    if (req.method === 'GET' && url.pathname === '/api/pool') {
      return json(res, 200, { accounts: listAccounts(), keys: listKeys() })
    }
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/backend-api/codex/responses')) {
      const key = authenticate(req)
      if (!key) {
        return json(res, 401, {
          error: { message: 'invalid api key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
        })
      }
      const raw = await readRaw(req)
      return await proxyResponses(req, res, key.person, raw)
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      // 故意不鉴权：不少客户端在填 key 之前就会先拉一次模型列表。
      // 列表来自池里第一个可用号的真实目录，缓存 10 分钟。
      const ids = await codexModelIds()
      return json(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'alpha-mind' })),
      })
    }
    return json(res, 404, { message: 'not found' })
  } catch (err) {
    return json(res, 500, { message: String(err?.message ?? err) })
  }
})

setInterval(() => {
  const now = Date.now()
  for (const [sid, session] of sessions) {
    if (now > session.expiresAt + 60_000) sessions.delete(sid)
  }
}, 60_000).unref()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush()
    process.exit(0)
  })
}

server.listen(PORT, HOST, () => {
  console.log(`alpha-mind enrollment on http://${HOST}:${PORT}/enroll`)
})
