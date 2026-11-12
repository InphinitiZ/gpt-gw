#!/usr/bin/env node
// 回归验证：上游返回响应头后长时间不结束（或超时中断）时，网关进程不能退出。
//
// 复现的历史问题：Readable.fromWeb(body).pipe(res) 不转发源流 error，
// 超时触发后 Readable emit('error') 无人监听 → 进程崩溃。
//
//   node scripts/test-stream-timeout.mjs
//
// 通过退出码判断：0 = 修复有效；1 = 进程挂了或行为异常。

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8891
const TIMEOUT_MS = 1200

const sha = (v) => createHash('sha256').update(v).digest('hex')
const now = new Date().toISOString()

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

// 假上游：给响应头和一段数据，然后永远不结束
const fake = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
  // 故意既不 end 也不再写
})

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)))

const fakePort = await listen(fake)

const gw = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    GW_PORT: String(PORT),
    GW_DATA_DIR: dataDir,
    GW_CHATGPT_BASE: `http://127.0.0.1:${fakePort}`,
    GW_UPSTREAM_TIMEOUT_MS: String(TIMEOUT_MS),
    GW_PROBE_INITIAL_DELAY_MS: '600000', // 别让探针干扰
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
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const fail = async (msg) => {
  console.error('✗', msg)
  console.error('--- gateway 日志 ---\n' + gwLog.split('\n').slice(-15).join('\n'))
  gw.kill('SIGKILL')
  fake.close()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(1)
}

if (!(await waitFor(`http://127.0.0.1:${PORT}/healthz`))) await fail('网关没起来')

// 发起请求：上游会给一段数据但不结束，网关应在 TIMEOUT_MS 后中断
const started = Date.now()
let clientErr = null
try {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 8000)
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer gw_stream_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', input: 'hi', stream: true }),
    signal: ac.signal,
  })
  await res.text()
} catch (err) {
  clientErr = err
}
const elapsed = Date.now() - started

await new Promise((r) => setTimeout(r, 600))

if (gw.exitCode !== null) await fail(`网关进程退出了，exitCode=${gw.exitCode}`)

let alive = false
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
  alive = r.ok
} catch {
  alive = false
}
if (!alive) await fail('网关不再响应 /healthz')

const sawStreamError = /stream 中断/.test(gwLog)
console.log(`✓ 进程存活，耗时 ${elapsed}ms，客户端${clientErr ? '收到中断：' + clientErr.name : '正常结束'}`)
console.log(`  ${sawStreamError ? '✓' : '✗'} 日志里有 stream 中断记录`)

gw.kill('SIGKILL')
fake.close()
rmSync(dataDir, { recursive: true, force: true })
process.exit(sawStreamError ? 0 : 1)
