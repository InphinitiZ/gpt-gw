// 额度 / 存活探针。每 10 分钟问一次上游"这个号还能不能用"，
// 这样即使没人发请求，也能在 10 分钟内发现号被撤销或额度耗尽。

import { fetchUsage, UpstreamError } from './openai.mjs'
import { accountsToProbe, updateAccount } from './store.mjs'
import { freshAccount } from './forward.mjs'

const INTERVAL_MS = Number(process.env.GW_PROBE_INTERVAL_MS ?? 10 * 60 * 1000)
const INITIAL_DELAY_MS = Number(process.env.GW_PROBE_INITIAL_DELAY_MS ?? 5000)

function errorCode(err) {
  const body = err instanceof UpstreamError ? err.body : null
  if (body && typeof body === 'object') return body.error?.code ?? body.code ?? null
  return null
}

// 401 不一定是死号：access token 自然过期也能刷回来。只有刷新也失败才算死。
function isAuthDeath(err) {
  return err instanceof UpstreamError && err.status === 401
}

async function probeAccount(account) {
  const at = new Date().toISOString()
  try {
    let fresh = await freshAccount(account)
    let usage
    try {
      usage = await fetchUsage(fresh.accessToken, fresh.accountId, { base: fresh.baseUrl })
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        // access 过期就强刷一次；刷不回来会在下面被标记 dead
        fresh = await freshAccount(fresh, { force: true })
        usage = await fetchUsage(fresh.accessToken, fresh.accountId, { base: fresh.baseUrl })
      } else {
        throw err
      }
    }

    updateAccount(account.id, {
      status: 'ok',
      quota: usage ?? account.quota ?? null,
      quotaAt: Date.now(),
      lastProbeAt: at,
      lastError: null,
    })
    return { id: account.id, label: account.label, status: 'ok', quota: usage ?? null }
  } catch (err) {
    const dead = isAuthDeath(err)
    updateAccount(account.id, {
      status: dead ? 'dead' : account.status,
      lastProbeAt: at,
      lastError: { at, code: errorCode(err), message: String(err.message).slice(0, 200) },
    })
    return {
      id: account.id,
      label: account.label,
      status: dead ? 'dead' : 'error',
      code: errorCode(err),
      error: String(err.message).slice(0, 200),
    }
  }
}

/** 跑一轮探针，返回每个号的结果。 */
export async function probeOnce() {
  const accounts = accountsToProbe()
  const results = []
  for (const account of accounts) {
    results.push(await probeAccount(account))
  }
  if (results.length) {
    const bad = results.filter((r) => r.status !== 'ok')
    console.log(`probe: ${results.length} 个号, ${bad.length} 个异常${bad.length ? ' → ' + JSON.stringify(bad) : ''}`)
  }
  return results
}

let timer = null

export function startProber() {
  if (timer) return
  const tick = () => {
    probeOnce().catch((err) => console.warn('probe 失败:', err.message))
  }
  setTimeout(tick, INITIAL_DELAY_MS).unref?.()
  timer = setInterval(tick, INTERVAL_MS)
  timer.unref?.()
  console.log(`probe: 每 ${Math.round(INTERVAL_MS / 1000)}s 检查一次账号状态`)
}
