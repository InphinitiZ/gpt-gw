#!/usr/bin/env node
// 流式响应中断的回归验证。覆盖三种情况：
//   A. 上游给了响应头和数据后一直不结束  → 网关按超时中断，进程存活
//   B. 客户端中途断开                  → 网关取消上游请求，进程存活
//   C. 上游中途销毁连接                → 网关记录并中断，进程存活
//
//   node scripts/test-stream-timeout.mjs
//
// 退出码 0 = 全部通过。断言里包含“在超时窗口内中断”，避免客户端自身超时掩盖问题。

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8891
const TIMEOUT_MS = 1200
const SLACK_MS = 2500 // 超时后允许的额外延迟（调度、代理等）

const sha = (v) => createHash('sha256').update(v).digest('hex')
const now = new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dataDir = mkdtempSync(join(tmpdir(), 'gw-stream-'))
writeFileSync(
  join(dataDir, 'state.json'),
  JSON.stringify({
    version: 3,
    accounts: [
      {
        id: 'acct_stream',
        label: 'fake-stream',
        owner: 'p_stream',
        accountId: 'fake-account-id',
        refreshToken: 'fake',
        accessToken: 'fake',
        expiresAt: Date.now() + 86_400_000,
        status: 'ok',
        exhaustedUntil: null,
        servedBy: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    keys: [{ id: 'key_stream', hash: sha('gw_stream_test'), person: 'p_stream', accountId: 'acct_stream', createdAt: now }],
    assignments: {},
    sessions: [],
    exitRequests: [],
    usage: {},
    people: { p_stream: { id: 'p_stream', displayName: 'stream-test', createdAt: now } },
  }),
)

// ── 假上游 ────────────────────────────────────────────────────────────────
let mode = 'stall'
let upstreamClosed = 0

const fake = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404)
    return res.end()
  }
  req.on('close', () => {
    upstreamClosed += 1
  })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('event: response.created\ndata: {"type":"response.created"}\n\n')

  if (mode === 'kill') {
    setTimeout(() => req.socket.destroy(), 200)
  }
  // stall 模式：故意既不 end 也不再写
})

const fakePort = await new Promise((resolve) =>
  fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)),
)

// ── 网关 ──────────────────────────────────────────────────────────────────
const gw = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    GW_PORT: String(PORT),
    GW_DATA_DIR: dataDir,
    GW_CHATGPT_BASE: `http://127.0.0.1:${fakePort}`,
    GW_UPSTREAM_TIMEOUT_MS: String(TIMEOUT_MS),
    GW_PROBE_INITIAL_DELAY_MS: '600000',
    GW_PROBE_INTERVAL_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let gwLog = ''
gw.stdout.on('data', (d) => (gwLog += d))
gw.stderr.on('data', (d) => (gwLog += d))

const waitFor = async (url, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(100)
  }
  return false
}

const cleanup = () => {
  gw.kill('SIGKILL')
  fake.close()
  rmSync(dataDir, { recursive: true, force: true })
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 网关的日志可能比客户端流结束晚一拍，轮询等待而不是立刻切片
const waitLog = async (mark, re, ms = 3000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (re.test(gwLog.slice(mark))) return true
    await sleep(50)
  }
  return false
}

const alive = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok
  } catch {
    return false
  }
}

/** 发一次请求，返回收到多少字节、是否报错、耗时。abortAfterMs 用于模拟客户端断开。 */
async function post({ abortAfterMs = 8000 } = {}) {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), abortAfterMs)
  let bytes = 0
  let text = ''
  let error = null
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer gw_stream_test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', input: 'hi', stream: true }),
      signal: ac.signal,
    })
    for await (const chunk of res.body) {
      bytes += chunk.length
      text += new TextDecoder().decode(chunk)
      if (text.includes('response.created') && bytes > 0 && abortAfterMs < 1000) break
    }
  } catch (err) {
    error = err
  } finally {
    clearTimeout(timer)
  }
  return { bytes, text, error, elapsed: Date.now() - started }
}

// ── 启动检查 ──────────────────────────────────────────────────────────────
if (!(await waitFor(`http://127.0.0.1:${PORT}/healthz`))) {
  console.error('✗ 网关没起来\n' + gwLog.slice(-800))
  cleanup()
  process.exit(1)
}

// ── A. 上游不结束 → 应在超时窗口内中断 ────────────────────────────────────
console.log('A. 上游给响应头后不结束')
{
  const logMark = gwLog.length
  const r = await post()
  check(r.text.includes('response.created'), '客户端收到首段数据')
  check(r.elapsed >= TIMEOUT_MS, '不是立刻中断', `${r.elapsed}ms ≥ ${TIMEOUT_MS}ms`)
  check(r.elapsed < TIMEOUT_MS + SLACK_MS, '在超时窗口内中断', `${r.elapsed}ms < ${TIMEOUT_MS + SLACK_MS}ms`)
  check(await waitLog(logMark, /stream 中断/), '日志记录了流中断')
  await sleep(300)
  check(await alive(), '进程存活，/healthz 正常')
}

// ── B. 客户端中途断开 → 上游请求应被取消 ──────────────────────────────────
console.log('B. 客户端中途断开')
{
  upstreamClosed = 0
  const logMark = gwLog.length
  const r = await post({ abortAfterMs: 400 })
  check(r.bytes > 0, '断开前已收到数据', `${r.bytes} 字节`)
  await sleep(800)
  check(upstreamClosed > 0, '上游连接已被取消')
  check(await waitLog(logMark, /stream 中断/), '日志记录了流中断')
  check(await alive(), '进程存活，/healthz 正常')
}

// ── C. 上游中途销毁连接 → 应记录并存活 ────────────────────────────────────
console.log('C. 上游中途断开连接')
{
  mode = 'kill'
  const logMark = gwLog.length
  const r = await post()
  check(r.bytes > 0, '断开前已收到数据', `${r.bytes} 字节`)
  check(r.error !== null || r.elapsed < TIMEOUT_MS + SLACK_MS, '连接被中断', `${r.elapsed}ms`)
  check(await waitLog(logMark, /stream 中断/), '日志记录了流中断')
  await sleep(300)
  check(await alive(), '进程存活，/healthz 正常')
}

cleanup()
if (failures.length) {
  console.error(`\n✗ ${failures.length} 项断言失败：${failures.join('、')}`)
  process.exit(1)
}
console.log('\n✓ 全部通过')
process.exit(0)
