import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DATA_DIR = resolve(process.env.GW_DATA_DIR ?? './data')
const STATE_PATH = resolve(DATA_DIR, 'state.json')

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

const empty = () => ({
  version: 3,
  accounts: [],
  keys: [],
  assignments: {},
  sessions: [],
  exitRequests: [],
  usage: {},
})

let state = load()

function load() {
  if (!existsSync(STATE_PATH)) return empty()
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return { ...empty(), ...parsed }
  } catch (err) {
    throw new Error(`state.json 解析失败，拒绝以空状态启动（会丢号）: ${err.message}`)
  }
}

// 全量重写 + rename。refresh token 轮转后如果这里写失败就是永久丢号，
// 所以调用方必须“先落盘再用新 token”。
function persist() {
  const tmp = `${STATE_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, STATE_PATH)
  dirty = false
}

// 计数类更新先攒 1 秒，避免每个请求都重写整个 state。
// 结构性变更（账号、key、申请、session）仍然立刻落盘。
let dirty = false
let flushTimer = null

function markDirty() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (dirty) persist()
  }, 1000)
  flushTimer.unref?.()
}

export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirty) persist()
}

export function dataDir() {
  return DATA_DIR
}

export function addAccount({ label, owner, accountId, email, refreshToken, accessToken, expiresAt }) {
  const existing = accountId ? state.accounts.find((a) => a.accountId === accountId) : null
  const now = new Date().toISOString()

  if (existing) {
    Object.assign(existing, {
      label: label ?? existing.label,
      owner: owner ?? existing.owner,
      email: email ?? existing.email,
      refreshToken,
      accessToken,
      expiresAt,
      status: 'ok',
      exhaustedUntil: null,
      updatedAt: now,
    })
    persist()
    return { account: existing, created: false }
  }

  const account = {
    id: `acct_${crypto.randomUUID().slice(0, 8)}`,
    label: label || email || (accountId ? accountId.slice(0, 8) : 'unresolved'),
    owner,
    accountId,
    email,
    refreshToken,
    accessToken,
    expiresAt,
    status: 'ok',
    exhaustedUntil: null,
    lastUsedAt: null,
    servedBy: {},
    createdAt: now,
    updatedAt: now,
  }
  state.accounts.push(account)
  persist()
  return { account, created: true }
}

export function updateAccount(id, patch) {
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return null
  Object.assign(account, patch, { updatedAt: new Date().toISOString() })
  persist()
  return account
}

// 一个人只保留一把有效 key：重新授权时旧的直接作废，避免 key 越攒越多。
export function rotateKey({ hash, person, accountId }) {
  state.keys = state.keys.filter((k) => k.person !== person)
  const key = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    hash,
    person,
    accountId,
    createdAt: new Date().toISOString(),
  }
  state.keys.push(key)
  persist()
  return key
}

export function accountsByOwner(person) {
  return state.accounts.filter((a) => a.owner === person)
}

export function accountByAccountId(accountId) {
  return state.accounts.find((a) => a.accountId === accountId) ?? null
}

export function personHasKey(person) {
  return state.keys.some((k) => k.person === person)
}

// 追加账号时用：已经有 key 就沿用，绝不换新的。
// 换 key 应该是管理员显式「重置」，不是加号的副作用。
export function ensureKey({ hash, person, accountId }) {
  const existing = state.keys.find((k) => k.person === person)
  if (existing) return { key: existing, created: false }
  return { key: issueKey({ hash, person, accountId }), created: true }
}

function issueKey({ hash, person, accountId }) {
  const key = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    hash,
    person,
    accountId,
    createdAt: new Date().toISOString(),
  }
  state.keys.push(key)
  persist()
  return key
}

export function keyByHash(hash) {
  return state.keys.find((k) => k.hash === hash) ?? null
}

export function assignmentFor(person) {
  return state.assignments[person] ?? null
}

function setAssignment(person, accountId, reason) {
  state.assignments[person] = { accountId, reason, at: new Date().toISOString() }
  persist()
}

function isUsable(account, now = Date.now()) {
  if (account.status === 'dead') return false
  if (account.exhaustedUntil && account.exhaustedUntil > now) return false
  return true
}

/**
 * 粘性分配：已经有分配且那个号还能用，就绝不动。
 * 只有号挂了 / 额度耗尽 才重新挑一个最久没被用过的。
 */
export function pickAccount(person) {
  const current = assignmentFor(person)
  const currentAccount = current ? state.accounts.find((a) => a.id === current.accountId) : null
  const ownUsable = state.accounts.find((a) => a.owner === person && isUsable(a)) ?? null

  // 1. 已经溢出到别人的号上：自己的号一恢复就回去，
  //    否则留在当前这个号上（粘性优先于「立刻回自己家」，避免每 15 分钟来回跳）
  if (currentAccount && isUsable(currentAccount)) {
    if (current.reason === 'spill' && ownUsable) {
      setAssignment(person, ownUsable.id, 'own')
      return { account: ownUsable, reused: false }
    }
    return { account: currentAccount, reused: true }
  }

  // 2. 用自己的号，这是默认路径
  if (ownUsable) {
    setAssignment(person, ownUsable.id, 'own')
    return { account: ownUsable, reused: false }
  }

  // 3. 自己的号用完 / 挂了，才借别人的
  const candidates = state.accounts.filter((a) => isUsable(a) && a.owner !== person)
  if (!candidates.length) return { account: null, reused: false }

  const account = candidates.sort((x, y) => (x.lastUsedAt ?? 0) - (y.lastUsedAt ?? 0))[0]
  setAssignment(person, account.id, 'spill')
  return { account, reused: false }
}

export function saveDiagnostic(obj) {
  const path = resolve(DATA_DIR, 'last-device-token.json')
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 })
  return path
}

export function accountsToProbe() {
  return state.accounts.filter((a) => a.status !== 'dead')
}

export function accountById(id) {
  return state.accounts.find((a) => a.id === id) ?? null
}

export function anyHealthyAccount() {
  return state.accounts.find((a) => isUsable(a)) ?? null
}

export function listAccounts() {
  const now = Date.now()
  return state.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    owner: a.owner,
    email: a.email,
    accountId: maskAccountId(a.accountId),
    status: a.status,
    exhausted: Boolean(a.exhaustedUntil && a.exhaustedUntil > now),
    exhaustedUntil: a.exhaustedUntil ?? null,
    quota: a.quota ?? null,
    quotaAt: a.quotaAt ?? null,
    lastProbeAt: a.lastProbeAt ?? null,
    lastError: a.lastError ?? null,
    borrowed: borrowedByOthers(a),
    assignedTo: Object.entries(state.assignments)
      .filter(([, v]) => v.accountId === a.id)
      .map(([person]) => person),
    updatedAt: a.updatedAt,
  }))
}

export function listKeys() {
  return state.keys.map((k) => ({ id: k.id, person: k.person, accountId: k.accountId, createdAt: k.createdAt }))
}

export function maskAccountId(id) {
  if (!id) return null
  return id.length <= 8 ? '***' : `${id.slice(0, 4)}…${id.slice(-4)}`
}

// ── 登录会话 ──────────────────────────────────────────────────────────────
// 只用 key 登录，不接外部账号体系：会话就是「这个人持有一把有效 key」的证明。

export function createSession(person, { days = 30 } = {}) {
  const session = {
    id: `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    person,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + days * 86400_000,
  }
  state.sessions.push(session)
  persist()
  return session
}

export function sessionById(id) {
  const session = state.sessions.find((s) => s.id === id)
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    state.sessions = state.sessions.filter((s) => s.id !== id)
    persist()
    return null
  }
  return session
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id)
  persist()
}

export function deleteSessionsFor(person) {
  state.sessions = state.sessions.filter((s) => s.person !== person)
  persist()
}

// ── 用量计数 ──────────────────────────────────────────────────────────────

export function recordUsage(person, accountId) {
  const now = new Date().toISOString()
  const usage = state.usage[person] ?? { requests: 0 }
  usage.requests += 1
  usage.lastAt = now
  state.usage[person] = usage

  const account = state.accounts.find((a) => a.id === accountId)
  if (account) {
    account.servedBy ??= {}
    account.servedBy[person] = (account.servedBy[person] ?? 0) + 1
    account.lastUsedAt = Date.now()
  }
  markDirty()
}

export function usageFor(person) {
  return state.usage[person] ?? { requests: 0, lastAt: null }
}

// 号主关心的是「我这个号被别人用了多少次」，自己用自己的不算
export function borrowedByOthers(account) {
  const served = account.servedBy ?? {}
  return Object.entries(served)
    .filter(([person]) => person !== account.owner)
    .reduce((sum, [, count]) => sum + count, 0)
}

// ── 退出托管申请 ──────────────────────────────────────────────────────────

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function pendingExitFor(person) {
  return state.exitRequests.find((r) => r.person === person && r.status === 'pending') ?? null
}

export function createExitRequest({ person, accountId, reason }) {
  // 幂等：已有待审批申请时直接返回原申请，避免用户连点造出一堆
  const existing = pendingExitFor(person)
  if (existing) return existing
  const request = {
    id: newId('exit'),
    person,
    accountId,
    reason: reason ?? '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    note: null,
  }
  state.exitRequests.push(request)
  persist()
  return request
}

export function cancelExitRequest(person) {
  const request = pendingExitFor(person)
  if (!request) return null
  request.status = 'cancelled'
  request.decidedAt = new Date().toISOString()
  persist()
  return request
}

export function listExitRequests(status = null) {
  return state.exitRequests
    .filter((r) => (status ? r.status === status : true))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function decideExitRequest(id, { status, note, admin }) {
  const request = state.exitRequests.find((r) => r.id === id)
  if (!request || request.status !== 'pending') return null
  request.status = status
  request.note = note ?? null
  request.decidedBy = admin ?? 'admin'
  request.decidedAt = new Date().toISOString()
  persist()
  return request
}

// ── 账号与 key 的运维操作 ─────────────────────────────────────────────────

export function removeAccount(id) {
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return null
  state.accounts = state.accounts.filter((a) => a.id !== id)
  for (const [person, assignment] of Object.entries(state.assignments)) {
    if (assignment.accountId === id) delete state.assignments[person]
  }
  persist()
  return account
}

export function revokeKeyFor(person) {
  const before = state.keys.length
  state.keys = state.keys.filter((k) => k.person !== person)
  state.sessions = state.sessions.filter((s) => s.person !== person)
  if (state.keys.length !== before) persist()
  return before - state.keys.length
}

// key 只存哈希，后台只能给出指纹，不能还原原文
export function keyFingerprintFor(person) {
  const key = state.keys.find((k) => k.person === person)
  if (!key) return null
  return { id: key.id, fingerprint: key.hash.slice(0, 8), createdAt: key.createdAt }
}

export function listPeople() {
  const people = new Set([...state.keys.map((k) => k.person), ...state.accounts.map((a) => a.owner)])
  const now = Date.now()
  return [...people].filter(Boolean).sort().map((person) => {
    const key = keyFingerprintFor(person)
    const accounts = state.accounts.filter((a) => a.owner === person)
    const assignment = assignmentFor(person)
    return {
      person,
      key,
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        email: a.email,
        status: a.status,
        exhausted: Boolean(a.exhaustedUntil && a.exhaustedUntil > now),
        quota: a.quota ?? null,
        lastProbeAt: a.lastProbeAt ?? null,
        borrowed: borrowedByOthers(a),
      })),
      assignedTo: assignment?.accountId ?? null,
      assignedReason: assignment?.reason ?? null,
      requests: usageFor(person).requests,
      pendingExit: Boolean(pendingExitFor(person)),
    }
  })
}
