import { createServer } from 'node:http'

// Node 22 的 fetch 不读 *_proxy 环境变量；Node 24 要加 --use-env-proxy 才读。
// 这里做一次兜底：装了 undici 就按环境变量接管全局 dispatcher，没装就提示。
const proxyEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
if (proxyEnv) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici')
    setGlobalDispatcher(new EnvHttpProxyAgent())
    console.log(`proxy: 已启用（${proxyEnv}）`)
  } catch {
    console.warn(
      `proxy: 检测到 *_proxy=${proxyEnv}，但当前 Node 没有可用的代理支持。\n` +
        '  · Node 24：用 node --use-env-proxy src/server.mjs 启动\n' +
        '  · Node 22：先 npm i undici，本进程会自动接管'
    )
  }
}
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { enrollPage, adminPage, mePage, landingPage } from './page.mjs'
import { startDeviceCode, pollDeviceCode, exchangeDeviceCode, extractAccountId, extractEmail, describeTokenShape, fetchCodexModels, UpstreamError } from './openai.mjs'
import {
  addAccount, rotateKey, listAccounts, listKeys, keyByHash, saveDiagnostic, anyHealthyAccount, flush,
  dataDir, listPeople, listExitRequests,
  createSession, sessionById, accountByAccountId, personHasKey, ensureKey, deleteSession, usageFor, deleteSessionsFor,
  createPerson, personInfo,
  accountById, createExitRequest, cancelExitRequest, pendingExitFor,
} from './store.mjs'
import { proxyResponses, freshAccount, setFault, clearFaults } from './forward.mjs'
import { startProber, probeOnce } from './probe.mjs'
import { approveExit, rejectExit, revokeUpstream } from './ops.mjs'

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

function currentUser(req) {
  const sid = cookieValue(req, 'gw_sid')
  return sid ? sessionById(sid) : null
}

function setUserCookie(res, sessionId) {
  res.setHeader('set-cookie', `gw_sid=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`)
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

function newSession({ person = null, displayName = null }) {
  const sid = randomUUID()
  const session = {
    sid,
    person,
    displayName,
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
  const user = currentUser(req)

  const person = user?.person ?? null
  let displayName = null
  if (!person) {
    // 先只记下名字，等授权真的成功再建身份——否则中途取消/失败会留下一条没 key 没号的孤儿记录
    displayName = String(body.name ?? '').trim()
    if (!displayName) return json(res, 400, { message: '缺少名字' })
  }

  const session = newSession({ person, displayName })
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

    // 一个账号只能有一个托管人。session.person 为 null 表示这是新用户，
    // 任何已存在的账号都属于别人。
    const existing = accountByAccountId(accountId)
    if (existing && existing.owner !== session.person) {
      failSession(session, `这个 ChatGPT 账号已经由 ${personInfo(existing.owner).displayName} 托管了。要换人得先让对方申请退出。`)
      return json(res, 200, { status: 'error', ...session.error })
    }

    // 走到这里授权才算真的成功，现在才建身份（避免孤儿 people 记录）
    const person = session.person ?? createPerson(session.displayName).id
    session.person = person

    const { account, created } = addAccount({
      owner: person,
      email,
      accountId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    })

    // 已经有 key 的人追加账号：沿用原 key，不换新的
    const hadKey = personHasKey(person)
    const plaintextKey = hadKey ? null : `gw_${randomBytes(24).toString('hex')}`
    const ensured = ensureKey({
      hash: plaintextKey ? hashKey(plaintextKey) : `reuse:${person}`,
      person,
      accountId,
    })

    // 登录态：enroll 完成即为这个人建立会话
    const userSession = createSession(person)
    setUserCookie(res, userSession.id)

    session.status = 'complete'
    session.result = {
      person,
      displayName: personInfo(person).displayName,
      key: plaintextKey,
      keyCreated: !hadKey,
      keyFingerprint: ensured.key.hash.slice(0, 8),
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

// ── 管理员令牌 ────────────────────────────────────────────────────────────
// 优先用环境变量；没配就生成一个存到 data/admin-token（0600），重启不变。
function loadAdminToken() {
  if (process.env.GW_ADMIN_TOKEN) return process.env.GW_ADMIN_TOKEN.trim()
  const path = resolve(dataDir(), 'admin-token')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* 还没生成过 */
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(path, token + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log(`admin: 已生成令牌，存在 ${path}`)
  return token
}

const ADMIN_TOKEN = loadAdminToken()
const adminSessions = new Map() // token -> 过期时间

function adminTokenOk(candidate) {
  const a = Buffer.from(String(candidate ?? ''))
  const b = Buffer.from(ADMIN_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

function isAdmin(req) {
  const sid = cookieValue(req, 'gw_admin')
  if (!sid) return false
  const expires = adminSessions.get(sid)
  if (!expires || expires < Date.now()) {
    adminSessions.delete(sid)
    return false
  }
  return true
}

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
    if (DEBUG && req.method === 'POST' && url.pathname === '/api/debug/probe') {
      return json(res, 200, { results: await probeOnce() })
    }
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
    if (req.method === 'GET' && url.pathname === '/') {
      // 已登录直接进面板，不让人再看到「新用户」入口
      if (currentUser(req)) {
        res.writeHead(302, { location: '/me', 'cache-control': 'no-store' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(landingPage())
    }
    if (req.method === 'GET' && url.pathname === '/enroll') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(enrollPage())
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
        data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'gpt-gw' })),
      })
    }
    // ── 用户端 ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req)
      const record = keyByHash(hashKey(String(body.key ?? '').trim()))
      if (!record) return json(res, 401, { message: 'key 不对' })
      const session = createSession(record.person)
      setUserCookie(res, session.id)
      return json(res, 200, { person: record.person })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const sid = cookieValue(req, 'gw_sid')
      if (sid) deleteSession(sid)
      res.setHeader('set-cookie', 'gw_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = currentUser(req)
      if (!user) return json(res, 401, { message: '未登录' })
      const me = listPeople().find((p) => p.person === user.person) ?? null
      return json(res, 200, {
        person: user.person,
        displayName: personInfo(user.person).displayName,
        key: me?.key ?? null,
        accounts: me?.accounts ?? [],
        assignedTo: me?.assignedTo ?? null,
        assignedReason: me?.assignedReason ?? null,
        requests: usageFor(user.person).requests,
        pendingExit: me?.pendingExit ?? false,
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/exit-request') {
      const user = currentUser(req)
      if (!user) return json(res, 401, { message: '未登录' })
      const body = await readBody(req)
      const account = body.accountId ? accountById(body.accountId) : null
      if (!account || account.owner !== user.person) return json(res, 400, { message: '这不是你的号' })
      const request = createExitRequest({
        person: user.person,
        accountId: account.id,
        reason: String(body.reason ?? '').slice(0, 500),
      })
      return json(res, 200, { request })
    }
    if (req.method === 'DELETE' && url.pathname === '/api/exit-request') {
      const user = currentUser(req)
      if (!user) return json(res, 401, { message: '未登录' })
      return json(res, 200, { ok: true, cancelled: Boolean(cancelExitRequest(user.person)) })
    }
    if (req.method === 'GET' && url.pathname === '/me') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(mePage())
    }
    // ── 管理端 ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/admin/login') {
      const body = await readBody(req)
      if (!adminTokenOk(body.token)) return json(res, 401, { message: '管理员令牌不正确' })
      const sid = randomBytes(24).toString('hex')
      adminSessions.set(sid, Date.now() + 12 * 3600 * 1000)
      res.setHeader('set-cookie', `gw_admin=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/admin/logout') {
      const sid = cookieValue(req, 'gw_admin')
      if (sid) adminSessions.delete(sid)
      res.setHeader('set-cookie', 'gw_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(adminPage())
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      if (!isAdmin(req)) return json(res, 401, { message: '需要管理员登录' })
      return json(res, 200, {
        accounts: listAccounts(),
        people: listPeople(),
        exitRequests: listExitRequests().slice(0, 50),
        probing: true,
      })
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/admin/exit/')) {
      if (!isAdmin(req)) return json(res, 401, { message: '需要管理员登录' })
      const id = decodeURIComponent(url.pathname.split('/').pop())
      const body = await readBody(req)
      const result =
        body.action === 'approve'
          ? approveExit({ requestId: id, admin: 'admin', note: body.note ?? null })
          : rejectExit({ requestId: id, admin: 'admin', note: body.note ?? '' })
      return json(res, result.ok ? 200 : 400, result)
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/reset-key') {
      if (!isAdmin(req)) return json(res, 401, { message: '需要管理员登录' })
      const body = await readBody(req)
      const person = String(body.person ?? '')
      const target = listPeople().find((p) => p.person === person)
      if (!target) return json(res, 404, { message: '找不到这个人' })
      const plaintext = `gw_${randomBytes(24).toString('hex')}`
      const accountId = target.accounts?.[0]?.id ?? null
      rotateKey({ hash: hashKey(plaintext), person, accountId })
      deleteSessionsFor(person)
      console.log(`admin: 重置了 ${target.displayName} 的 key`)
      return json(res, 200, {
        ok: true,
        person,
        key: plaintext,
        keyFingerprint: hashKey(plaintext).slice(0, 8),
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/revoke') {
      if (!isAdmin(req)) return json(res, 401, { message: '需要管理员登录' })
      const body = await readBody(req)
      if (body.confirm !== true) return json(res, 400, { ok: false, reason: 'confirm_required' })
      return json(res, 200, await revokeUpstream({ accountId: body.accountId, admin: 'admin' }))
    }
    return json(res, 404, { message: 'not found' })
  } catch (err) {
    console.error(`500 ${req.method} ${url.pathname}:`, err?.message ?? err)
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
  console.log(`gpt-gw on http://${HOST}:${PORT}/enroll`)
  startProber()
})
