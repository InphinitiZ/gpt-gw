// 危险操作集中在这里，路由层只负责鉴权和参数校验。
// 退出托管 = 只删本地凭据，不碰上游授权（revoke 会登出号主所有设备，实测过）。

import {
  accountById,
  accountsByOwner,
  decideExitRequest,
  listExitRequests,
  removeAccount,
  removePerson,
  revokeKeyFor,
} from './store.mjs'
import { revokeToken } from './openai.mjs'

// 一个人名下没有任何号了 → 撤销 key、清掉会话和人记录
function revokeIfNoAccountsLeft(person) {
  if (accountsByOwner(person).length > 0) return 0
  const n = revokeKeyFor(person)
  removePerson(person)
  return n
}

export function findExitRequest(id) {
  return listExitRequests().find((r) => r.id === id) ?? null
}

/**
 * 批准退出托管：
 * 1. 把号从池里摘掉（依赖它的人下次请求会自动 re-pin）
 * 2. 撤销这个人的 key 和所有会话（没有贡献就不能用别人的号）
 * 3. 结束申请单
 * 不调用上游 revoke —— 那会把号主在所有设备上的登录一起干掉。
 */
export function approveExit({ requestId, admin, note = null }) {
  const request = findExitRequest(requestId)
  if (!request || request.status !== 'pending') return { ok: false, reason: 'not_pending' }

  const account = request.accountId ? accountById(request.accountId) : null
  if (account) removeAccount(account.id)

  // 只在「一个号都不剩」时才撤销 key：还有号在池里就仍然算有贡献
  const revokedKeys = revokeIfNoAccountsLeft(request.person)
  const remaining = accountsByOwner(request.person)
  const decided = decideExitRequest(requestId, { status: 'approved', note, admin })

  return {
    ok: true,
    request: decided,
    removedAccount: account ? { id: account.id, label: account.label } : null,
    revokedKeys,
    remainingAccounts: remaining.length,
  }
}

export function rejectExit({ requestId, admin, note }) {
  const request = findExitRequest(requestId)
  if (!request || request.status !== 'pending') return { ok: false, reason: 'not_pending' }
  if (!note) return { ok: false, reason: 'note_required' }
  return { ok: true, request: decideExitRequest(requestId, { status: 'rejected', note, admin }) }
}

/**
 * 管理员核弹：撤销上游授权并摘号。
 * 实测这个接口按「用户」撤销，会让该账号所有已登录设备一起掉线。
 * 只用于止损（凭据外泄、离职、账号异常），不走正常退出流程。
 */
export async function revokeUpstream({ accountId, admin }) {
  const account = accountById(accountId)
  if (!account) return { ok: false, reason: 'account_not_found' }

  let revoke
  try {
    revoke = await revokeToken(account.refreshToken)
  } catch (err) {
    // revoke 失败也要继续摘号：留着我们不再管理的凭据没有意义
    revoke = { ok: false, status: 0, error: String(err.message) }
  }

  removeAccount(account.id)
  // 和退出托管同一条规则：撤掉最后一个号，这个人就没有贡献了，key 一起撤销
  const revokedKeys = revokeIfNoAccountsLeft(account.owner)
  return { ok: true, revokedBy: admin, revoke, revokedKeys, removed: { id: account.id, label: account.label } }
}
