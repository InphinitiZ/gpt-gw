#!/usr/bin/env node
// 先用这个脚本验证“网关所在机器能不能发起设备授权”。
// Cloudflare 对 /deviceauth/* 有独立的机器人策略，办公室网和机房 IP 结果可能完全不同。
//
//   node scripts/probe-deviceauth.mjs          只申请验证码，不轮询
//   node scripts/probe-deviceauth.mjs --wait   申请后一直轮询，直到你授权或超时

import { startDeviceCode, pollDeviceCode, UpstreamError } from '../src/openai.mjs'

const wait = process.argv.includes('--wait')

function line(label, value) {
  console.log(`${label.padEnd(16)} ${value}`)
}

let device
try {
  device = await startDeviceCode()
} catch (err) {
  if (err instanceof UpstreamError) {
    if (err.challenge) {
      console.error('✗ 被 Cloudflare 拦了（返回的是 HTML 挑战页，不是 JSON）')
      console.error('  这条路径走不通，改用本机 codex login + 上传 auth.json 的降级方案。')
    } else {
      console.error(`✗ 上游返回 ${err.status}`)
      console.error(JSON.stringify(err.body).slice(0, 500))
    }
  } else {
    console.error('✗ 请求失败:', err.message)
  }
  process.exit(1)
}

line('验证码', device.userCode)
line('授权页', device.verificationUri)
line('轮询间隔', `${device.intervalSec}s`)
line('有效期', `${device.expiresInSec}s`)
console.log('\n浏览器打开授权页，登录要上交的号，输入上面的验证码。\n')

if (!wait) {
  console.log('（没有加 --wait，只验证了端点可达，没有轮询）')
  process.exit(0)
}

const deadline = Date.now() + device.expiresInSec * 1000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, device.intervalSec * 1000))
  try {
    const res = await pollDeviceCode(device.deviceAuthId, device.userCode)
    if (res.status === 'pending') {
      process.stdout.write('.')
      continue
    }
    console.log(`\n✓ ${res.status}`)
    if (res.status === 'complete') {
      const t = res.tokens
      console.log(
        JSON.stringify(
          {
            has_access_token: Boolean(t.access_token),
            has_refresh_token: Boolean(t.refresh_token),
            has_id_token: Boolean(t.id_token),
            expires_in: t.expires_in,
            scope: t.scope,
          },
          null,
          2,
        ),
      )
    }
    process.exit(0)
  } catch (err) {
    console.error('\n✗ 轮询失败:', err.message)
    process.exit(1)
  }
}

console.log('\n✗ 超时')
process.exit(1)
