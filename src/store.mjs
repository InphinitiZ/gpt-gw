import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DATA_DIR = resolve(process.env.GW_DATA_DIR ?? './data')
const STATE_PATH = resolve(DATA_DIR, 'state.json')

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

const empty = () => ({ version: 2, accounts: [], keys: [], assignments: {} })

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
  if (current) {
    const account = state.accounts.find((a) => a.id === current.accountId)
    if (account && isUsable(account)) return { account, reused: true }
  }

  const candidates = state.accounts.filter((a) => isUsable(a))
  if (!candidates.length) return { account: null, reused: false }

  const account = candidates.sort((x, y) => (x.lastUsedAt ?? 0) - (y.lastUsedAt ?? 0))[0]
  setAssignment(person, account.id, current ? 'repin' : 'initial')
  return { account, reused: false }
}

export function saveDiagnostic(obj) {
  const path = resolve(DATA_DIR, 'last-device-token.json')
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 })
  return path
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
    quota: a.quota ?? null,
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
