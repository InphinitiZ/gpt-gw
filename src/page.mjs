
// 两个页面共用的接入说明。用 data-fill 占位，前端填 origin 和 key。
const usageHtml = `
  <h3>接入方式</h3>
  <p class="hint">OpenAI Responses 协议，SSE 流式。认证一律 <code class="inline">Authorization: Bearer &lt;key&gt;</code>。</p>
  <pre>POST <span data-fill="origin"></span>/v1/responses   对话（Responses 协议）
GET  <span data-fill="origin"></span>/v1/models        模型列表
Authorization: Bearer <span data-fill="key"></span></pre>

  <h3>Codex CLI</h3>
  <pre># ~/.codex/config.toml
model_provider = "gpt-gw"

[model_providers.gpt-gw]
name = "gpt-gw"
base_url = "<span data-fill="origin"></span>/v1"
env_key = "GPT_GW_KEY"
wire_api = "responses"

# 然后
export GPT_GW_KEY=<span data-fill="key"></span></pre>

  <h3>Chatbox</h3>
  <pre>API 模式：OpenAI Responses API 兼容
API 主机：<span data-fill="origin"></span>/v1
API 路径：/responses
API 密钥：<span data-fill="key"></span>

保存后点「获取」拉模型，再选一个开始对话。</pre>

  <h3>curl</h3>
  <pre>curl -N <span data-fill="origin"></span>/v1/responses \
  -H "Authorization: Bearer <span data-fill="key"></span>" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-6.1-sol","input":[{"type":"message","role":"user",
       "content":[{"type":"input_text","text":"hi"}]}],"stream":true}'</pre>

  <p class="hint">
    注意：<code class="inline">input</code> 必须是数组，传字符串会 400；
    <code class="inline">store</code> 会被强制改成 false（池号是别人在用，不落对方历史）；
    可用模型以 <code class="inline">/v1/models</code> 为准，不同账号看到的可能不同。
  </p>

  <style>
    .usage h3 { font-size:13px; color:var(--muted); margin:22px 0 8px; font-weight:600; }
    .usage pre { background:rgba(127,127,127,.1); padding:12px 14px; border-radius:8px; overflow-x:auto; font-size:12.5px; line-height:1.6; margin:0; }
    .usage code.inline { background:rgba(127,127,127,.14); padding:1px 5px; border-radius:4px; font-size:12.5px; }
  </style>
`


export function enrollPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>把 ChatGPT 号加入共享池</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --bg:#fff; --accent:#0a7c53; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#999; --line:#2a2a2a; --bg:#111; --accent:#39d29a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:560px; margin:0 auto; padding:56px 20px 80px; }
  h1 { font-size:22px; margin:0 0 8px; letter-spacing:-0.01em; }
  p.lede { color:var(--muted); margin:0 0 28px; }
  section { display:none; }
  section.on { display:block; }
  label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  input[type=text] { width:100%; padding:10px 12px; font-size:15px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); }
  input[type=text]:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:16px; padding:10px 18px; font-size:15px; font-weight:500; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .code { font:600 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:0.14em; padding:18px; text-align:center; border:1px dashed var(--line); border-radius:10px; margin:18px 0; user-select:all; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .ghost { background:transparent; color:var(--fg); border:1px solid var(--line); margin-top:0; }
  .hint { color:var(--muted); font-size:13px; }
  .status { margin-top:18px; font-size:14px; color:var(--muted); min-height:22px; }
  .ok { color:var(--accent); font-weight:600; }
  .err { color:#c0392b; font-weight:600; }
  pre { background:rgba(127,127,127,.1); padding:14px; border-radius:8px; overflow-x:auto; font-size:13px; line-height:1.5; }
  .warn { border-left:3px solid #b7791f; padding:10px 14px; background:rgba(183,121,31,.08); border-radius:0 8px 8px 0; font-size:13px; margin:20px 0; }
  ol { padding-left:20px; color:var(--muted); font-size:14px; }
  code.inline { background:rgba(127,127,127,.14); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<main>
  <h1>把 ChatGPT 号加入共享池</h1>
  <p class="lede">授权只发生一次。完成后，这个号的额度会被分配到需要的人身上，你本机用网关 key 访问，不再登录这个号。</p>

  <section id="s1" class="on">
    <label for="name">你的名字或公司邮箱（用来绑定网关 key）</label>
    <input id="name" type="text" placeholder="你的名字" autocomplete="username">
    <button id="go">开始授权</button>
    <div class="status" id="st1"></div>
  </section>

  <section id="s2">
    <p>1. 点下面的按钮打开 OpenAI 的设备授权页</p>
    <div class="row">
      <button id="open" class="ghost">打开 auth.openai.com/codex/device</button>
      <button id="copy" class="ghost">复制验证码</button>
    </div>
    <div class="code" id="code">…</div>
    <p>2. 在那边登录<strong>你要上交的这个号</strong>，输入上面的验证码并确认</p>
    <p class="hint">这个页面会一直等，确认完自动收尾，不用回来刷新。</p>
    <div class="status" id="st2">等待授权…</div>
  </section>

  <section id="s3">
    <p class="ok" id="done">已加入共享池。</p>
    <div class="warn" id="unresolved" style="display:none">
      号已经入库，但没从 token 里解析出账号 id。先别拿去用，把 <code class="inline">data/last-device-token.json</code> 发给管理员。
    </div>
    <p class="hint" id="keyhint">这是你的网关 key，只显示这一次：</p>
    <pre id="key"></pre>
    <div class="usage" id="usage">${usageHtml}</div>
    <div class="warn">
      建议本机不再 <code class="inline">codex login</code> 这个号。主要理由是请求会<strong>绕过网关</strong>——
      不粘连、吃不到 prompt cache、额度也不进池子的账。两边同时刷新 token 可能互相踢下线，
      这条还没实测，属于次要风险。
    </div>
    <button id="again" class="ghost">再交一个号</button>
  </section>

  <section id="s4">
    <p class="err" id="errmsg"></p>
    <div id="fallback" style="display:none">
      <p>网关的出口 IP 被 Cloudflare 拦了，发不出设备授权请求。三个办法，按推荐顺序：</p>
      <ol>
        <li>给网关配代理后重启：<br>
          <code class="inline">HTTPS_PROXY=http://代理地址 node --use-env-proxy src/server.mjs</code></li>
        <li>把网关挪到能直连 <code class="inline">auth.openai.com</code> 的网络</li>
        <li>等你所在机器上跑本地授权（还没实现）</li>
      </ol>
      <p class="hint">判断标准：在网关那台机器上 <code class="inline">curl -sI https://auth.openai.com/codex/device</code>
      能返回 200 而不是 <code class="inline">Just a moment...</code>，就说明出口没问题。</p>
    </div>
    <div id="loginbox" style="display:none">
      <p>这个名称已经有人用过了。如果这是你，用原来的 key 登录后再加号：</p>
      <div class="row">
        <input id="keyin" type="password" placeholder="gw_..." style="flex:1">
        <button id="loginbtn" class="ghost">登录</button>
      </div>
    </div>
    <button id="retry" class="ghost">重试</button>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id)
function fillUsage(key) {
  document.querySelectorAll('[data-fill="origin"]').forEach((el) => { el.textContent = location.origin })
  document.querySelectorAll('[data-fill="key"]').forEach((el) => { el.textContent = key || 'gw_你的key' })
}
const show = (id) => { for (const s of document.querySelectorAll('section')) s.classList.toggle('on', s.id === id) }
let sid = null, timer = null

async function start() {
  const name = $('name').value.trim()
  if (!name) { $('st1').textContent = '先填个名字'; return }
  // 必须在任何 await 之前同步开窗，否则会被弹窗拦截器干掉
  let tab = null
  try { tab = window.open('', '_blank') } catch {}
  $('go').disabled = true
  $('st1').textContent = '正在向 OpenAI 申请验证码…'
  try {
    const r = await fetch('/api/enroll/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    })
    const j = await r.json()
    if (!r.ok) return fail(j)
    sid = j.sid
    $('code').textContent = j.userCode
    $('open').onclick = () => window.open(j.verificationUri, '_blank', 'noopener')
    $('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(j.userCode); $('copy').textContent = '已复制' } catch {}
    }
    show('s2')
    if (tab) {
      try { tab.location.href = j.verificationUri } catch { tab = null }
    }
    if (!tab) $('st2').textContent = '浏览器拦了新标签，点上面「打开 auth.openai.com/codex/device」手动打开'
    timer = setInterval(tick, Math.max(3, j.intervalSec) * 1000)
  } catch (e) {
    fail({ message: String(e) })
  } finally {
    $('go').disabled = false
  }
}

async function tick() {
  const r = await fetch('/api/enroll/status?sid=' + encodeURIComponent(sid))
  const j = await r.json()
  if (j.status === 'pending') return
  clearInterval(timer)
  if (j.status === 'complete') {
    if (j.account && j.account.accountIdResolved === false) $('unresolved').style.display = 'block'
    if (!j.key) {
      const what = j.account.created ? '新号已加入你的托管' : '这个号原本就在池里，凭据已更新'
      $('keyhint').textContent = what + '；沿用你原来的 key（指纹 ' + j.keyFingerprint + '），不重复显示。'
      $('key').textContent = '（沿用原 key，无需更新本地配置）'
    } else {
      $('key').textContent = j.key
    }
    $('done').textContent = j.account.created ? '已加入共享池。' : '凭据已更新。'
    fillUsage(j.key)
    show('s3')
  } else {
    fail(j)
  }
}

function fail(j) {
  clearInterval(timer)
  $('errmsg').textContent = j.message || '授权失败'
  $('fallback').style.display = j.challenge ? 'block' : 'none'
  $('loginbox').style.display = j.needLogin ? 'block' : 'none'
  show('s4')
}

async function boot() {
  try {
    const r = await fetch('/api/me')
    if (!r.ok) return
    const me = await r.json()
    const input = $('name')
    input.value = me.person
    input.disabled = true
    $('st1').textContent = '已登录为 ' + (me.displayName || me.person) + '，现在交的号会加到这个人名下'
  } catch {}
}

$('loginbtn').onclick = async () => {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: $('keyin').value.trim() })
  })
  if (!r.ok) { $('errmsg').textContent = 'key 不对'; return }
  const me = await r.json()
  $('name').value = me.person
  $('name').disabled = true
  $('st1').textContent = '已登录为 ' + (me.displayName || me.person)
  show('s1')
}

$('go').onclick = start
$('retry').onclick = () => { $('st1').textContent = ''; show('s1') }
$('again').onclick = () => { $('st1').textContent = ''; show('s1') }
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })
boot()
</script>
</body>
</html>`
}

export function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gpt-gw 管理台</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --bg:#fff; --ok:#0a7c53; --bad:#c0392b; --warn:#b7791f; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#999; --line:#2a2a2a; --bg:#111; --ok:#39d29a; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:1000px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:14px; margin:32px 0 10px; color:var(--muted); font-weight:600; letter-spacing:.02em; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid var(--line); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); } .muted { color:var(--muted); }
  button { font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--muted); }
  button.danger { color:var(--bad); border-color:var(--bad); }
  input { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:16px; }
  .right { margin-left:auto; }
  .empty { color:var(--muted); padding:12px 0; }
  pre { margin:0; font-size:12px; white-space:pre-wrap; word-break:break-all; color:var(--bad); }
</style>
</head>
<body>
<main>
  <h1>gpt-gw 管理台</h1>
  <p class="muted" style="margin:0 0 24px">账号状态、托管人、退出申请</p>

  <p id="boot" class="bad" style="display:none;white-space:pre-wrap"></p>

  <section id="login" style="display:none">
    <p class="muted">输入管理员令牌。没有的话看 <code>data/admin-token</code>。</p>
    <div class="bar"><input id="tok" type="password" placeholder="admin token" style="flex:1"><button id="enter">进入</button></div>
    <p id="loginerr" class="bad"></p>
  </section>

  <section id="panel" style="display:none">
    <div class="bar">
      <button id="refresh">刷新</button>
      <span id="updated" class="muted"></span>
      <span class="right"></span>
      <button id="logout">退出</button>
    </div>

    <h2>账号</h2>
    <table><thead><tr>
      <th>账号</th><th>状态</th><th>额度</th><th>最近探测</th><th>被借</th><th>当前使用者</th><th></th>
    </tr></thead><tbody id="accounts"></tbody></table>

    <h2>托管人</h2>
    <table><thead><tr>
      <th>姓名</th><th>自己的号</th><th>当前在用</th><th>本周请求</th><th>key 指纹</th><th>待退出</th>
    </tr></thead><tbody id="people"></tbody></table>

    <h2>退出申请</h2>
    <table><thead><tr>
      <th>申请人</th><th>要退的号</th><th>理由</th><th>时间</th><th>状态</th><th>操作</th>
    </tr></thead><tbody id="exits"></tbody></table>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id)
function fillUsage(key) {
  document.querySelectorAll('[data-fill="origin"]').forEach((el) => { el.textContent = location.origin })
  document.querySelectorAll('[data-fill="key"]').forEach((el) => { el.textContent = key || 'gw_你的key' })
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

function showErr(msg) {
  const el = $('boot')
  if (!el) return
  el.style.display = 'block'
  el.textContent = String(msg)
}
window.addEventListener('error', (e) => showErr('页面脚本错误：' + e.message))
window.addEventListener('unhandledrejection', (e) => showErr('请求失败：' + ((e.reason && e.reason.message) || e.reason)))

function badge(status, exhausted) {
  if (exhausted) return '<span class="pill warn">额度耗尽</span>'
  if (status === 'ok') return '<span class="pill ok">正常</span>'
  if (status === 'dead') return '<span class="pill bad">已失效</span>'
  return '<span class="pill">' + esc(status || '未知') + '</span>'
}

function pct(q) {
  if (!q) return '<span class="muted">—</span>'
  const p = q.primary && typeof q.primary.usedPercent === 'number' ? q.primary.usedPercent : null
  const s = q.secondary && typeof q.secondary.usedPercent === 'number' ? q.secondary.usedPercent : null
  const parts = []
  if (p !== null) parts.push('周 ' + p + '%')
  if (s !== null) parts.push('5h ' + s + '%')
  if (q.primary && q.primary.resetAfterSec) {
    const h = Math.round(q.primary.resetAfterSec / 3600)
    parts.push(h >= 1 ? h + ' 小时后重置' : Math.round(q.primary.resetAfterSec / 60) + ' 分钟后重置')
  }
  if (q.resetCredits) parts.push('重置券 ' + q.resetCredits)
  if (q.limitReached) parts.push('已触顶')
  return parts.length ? esc(parts.join(' · ')) : '<span class="muted">—</span>'
}

function ago(iso) {
  if (!iso) return '<span class="muted">从未</span>'
  const diff = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diff)) return '<span class="muted">—</span>'
  const m = Math.round(diff / 60000)
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'
}

async function load() {
  let r
  try {
    r = await fetch('/api/admin/overview')
  } catch (err) {
    showErr('连不上网关：' + err.message)
    $('login').style.display = 'block'
    return
  }
  if (r.status === 401) { $('login').style.display = 'block'; $('panel').style.display = 'none'; return }
  if (!r.ok) {
    showErr('管理接口返回 ' + r.status + '：' + (await r.text()).slice(0, 200))
    $('login').style.display = 'block'
    return
  }
  const d = await r.json()
  if (!Array.isArray(d.accounts)) {
    showErr('返回结构异常：' + JSON.stringify(d).slice(0, 200))
    $('login').style.display = 'block'
    return
  }
  $('login').style.display = 'none'; $('panel').style.display = 'block'
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString()

  $('accounts').innerHTML = d.accounts.length ? d.accounts.map((a) => {
    const err = a.lastError ? '<pre>' + esc((a.lastError.code || '') + ' ' + (a.lastError.message || '')) + '</pre>' : ''
    return '<tr><td><strong>' + esc(a.label) + '</strong><br><span class="muted">' + esc(a.email || a.accountId) + '</span></td>' +
      '<td>' + badge(a.status, a.exhausted) + (err ? '<br>' + err : '') + '</td>' +
      '<td>' + pct(a.quota) + '</td>' +
      '<td>' + ago(a.lastProbeAt) + '</td>' +
      '<td>' + (a.borrowed || 0) + '</td>' +
      '<td>' + (a.assignedTo && a.assignedTo.length ? esc(a.assignedTo.join(', ')) : '<span class="muted">—</span>') + '</td>' +
      '<td><button class="danger" data-revoke="' + esc(a.id) + '" data-label="' + esc(a.label) + '">强制撤销</button></td></tr>'
  }).join('') : '<tr><td colspan="7" class="empty">池子里还没有号</td></tr>'

  $('people').innerHTML = d.people.length ? d.people.map((p) => {
    const own = p.account ? esc(p.account.label) + '（被借 ' + p.account.borrowed + ' 次）' : '<span class="muted">无</span>'
    const using = p.assignedTo ? (p.assignedReason === 'own' ? '<span class="ok">自己的号</span>' : '<span class="warn">借别人的号</span>') : '<span class="muted">—</span>'
    return '<tr><td>' + esc(p.displayName || p.person) + '</td><td>' + own + '</td><td>' + using + '</td>' +
      '<td>' + p.requests + '</td><td class="muted">' + esc(p.key ? p.key.fingerprint : '无 key') + '</td>' +
      '<td>' + (p.pendingExit ? '<span class="warn">有</span>' : '<span class="muted">—</span>') + '</td></tr>'
  }).join('') : '<tr><td colspan="6" class="empty">还没有人</td></tr>'

  const pend = d.exitRequests || []
  $('exits').innerHTML = pend.length ? pend.map((r) => {
    const actions = r.status === 'pending'
      ? '<button data-approve="' + esc(r.id) + '">通过</button> <button data-reject="' + esc(r.id) + '">驳回</button>'
      : '<span class="muted">' + esc(r.note || '') + '</span>'
    const cls = r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'muted'
    return '<tr><td>' + esc(r.person) + '</td><td class="muted">' + esc(r.accountId || '—') + '</td>' +
      '<td>' + esc(r.reason || '—') + '</td><td>' + ago(r.createdAt) + '</td>' +
      '<td class="' + cls + '">' + esc(r.status) + '</td><td>' + actions + '</td></tr>'
  }).join('') : '<tr><td colspan="6" class="empty">没有申请</td></tr>'
}

async function act(url, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) alert(j.message || j.reason || ('操作失败 ' + r.status))
  load()
}

document.addEventListener('click', (e) => {
  const t = e.target
  if (t.dataset.approve) act('/api/admin/exit/' + t.dataset.approve, { action: 'approve', note: '' })
  if (t.dataset.reject) {
    const note = prompt('驳回理由（必填）')
    if (note) act('/api/admin/exit/' + t.dataset.reject, { action: 'reject', note })
  }
  if (t.dataset.revoke) {
    const msg = '强制撤销「' + t.dataset.label + '」？\\n\\n这会终止该账号所有设备上的登录（包括号主自己的手机和电脑），且不可恢复。'
    act('/api/admin/revoke', { accountId: t.dataset.revoke, confirm: true }, msg)
  }
})

$('enter').onclick = async () => {
  const r = await fetch('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('tok').value }) })
  if (r.ok) load()
  else $('loginerr').textContent = '令牌不正确'
}
$('tok') && $('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enter').click() })
$('refresh').onclick = load
$('addbtn').onclick = () => { location.href = '/enroll' }

$('logout').onclick = async () => { await fetch('/admin/logout', { method: 'POST' }); $('panel').style.display='none'; $('login').style.display='block' }
load()
</script>
</body>
</html>`
}

export function mePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的托管</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --bg:#fff; --ok:#0a7c53; --bad:#c0392b; --warn:#b7791f; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#999; --line:#2a2a2a; --bg:#111; --ok:#39d29a; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:640px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:13px; color:var(--muted); margin:32px 0 10px; font-weight:600; }
  .muted { color:var(--muted); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  .row { display:flex; align-items:center; gap:10px; }
  .grow { flex:1; }
  .num { font:600 18px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; }
  button { font:inherit; font-size:14px; padding:6px 12px; border-radius:7px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--ok); border-color:var(--ok); color:#fff; }
  button.danger { color:var(--bad); border-color:var(--bad); }
  input { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); width:100%; }
  .empty { color:var(--muted); border:1px dashed var(--line); border-radius:10px; padding:20px; text-align:center; }
  .pill { font-size:12px; padding:1px 8px; border-radius:99px; border:1px solid var(--line); }
</style>
</head>
<body>
<main>
  <div id="loading" class="muted">加载中…</div>

  <p id="boot" class="bad" style="display:none;white-space:pre-wrap"></p>

  <section id="login" style="display:none">
    <h1>我的托管</h1>
    <p class="muted">用网关发你的 key 登录。</p>
    <input id="keyin" type="password" placeholder="gw_...">
    <div style="margin-top:12px"><button class="primary" id="loginbtn">登录</button></div>
    <p id="loginerr" class="bad"></p>
  </section>

  <section id="panel" style="display:none">
    <div class="row">
      <h1 class="grow" id="who"></h1>
      <button id="logout">退出登录</button>
    </div>
    <p class="muted" id="keyline" style="margin:2px 0 0"></p>

    <div class="row" style="align-items:baseline">
      <h2 class="grow">我托管的号</h2>
      <button id="addbtn" style="font-size:13px;padding:4px 10px">+ 加一个号</button>
    </div>
    <div id="accounts"></div>

    <h2>本周用量</h2>
    <div class="card row">
      <div class="grow">
        <div class="num" id="reqs">0</div>
        <div class="muted">次请求</div>
      </div>
      <div class="grow">
        <div id="using" class="num" style="font-size:15px"></div>
        <div class="muted">当前在用</div>
      </div>
    </div>

    <h2>如何使用</h2>
    <details class="card usage" style="padding:6px 16px">
      <summary style="cursor:pointer;padding:8px 0;font-size:14px">端点、Codex、Chatbox、curl</summary>
      <div>${usageHtml}</div>
    </details>

    <h2>说明</h2>
    <p class="muted" style="font-size:13px">
      请求优先走你自己的号，用完了才借别人的。你自己用的部分不计入「被借」。
      退出托管只是把号从池里拿走，不会影响你在任何设备上的 ChatGPT 登录。
    </p>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id)
function fillUsage(key) {
  document.querySelectorAll('[data-fill="origin"]').forEach((el) => { el.textContent = location.origin })
  document.querySelectorAll('[data-fill="key"]').forEach((el) => { el.textContent = key || 'gw_你的key' })
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
function showErr(msg) {
  const el = $('boot')
  if (!el) return
  el.style.display = 'block'
  el.textContent = String(msg)
}
window.addEventListener('error', (e) => showErr('页面脚本错误：' + e.message))
window.addEventListener('unhandledrejection', (e) => showErr('请求失败：' + ((e.reason && e.reason.message) || e.reason)))

let me = null

function badge(a) {
  if (a.exhausted) return '<span class="pill warn">额度用完</span>'
  if (a.status === 'dead') return '<span class="pill bad">已失效</span>'
  if (a.status === 'ok') return '<span class="pill ok">在池中</span>'
  return '<span class="pill">' + esc(a.status || '未知') + '</span>'
}

function pct(q) {
  if (!q || !q.primary) return ''
  return q.primary.usedPercent != null ? '本周已用 ' + q.primary.usedPercent + '%' : ''
}

function render() {
  $('who').textContent = me.displayName || me.person
  $('keyline').textContent = me.key ? 'key 指纹 ' + me.key.fingerprint : ''
  $('reqs').textContent = me.requests
  $('using').textContent = me.assignedTo ? (me.assignedReason === 'own' ? '自己的号' : '借别人的号') : '—'

  const list = me.accounts || []
  $('accounts').innerHTML = list.length ? list.map((a) => {
    const reauth = a.status === 'dead' ? '<button data-reauth="1">重新授权</button> ' : ''
    const act = me.pendingExit
      ? '<span class="muted" style="font-size:13px">退出申请审批中</span>'
      : reauth + '<button class="danger" data-exit="' + esc(a.id) + '">退出托管</button>'
    return '<div class="card"><div class="row">' +
      '<div class="grow"><strong>' + esc(a.label) + '</strong><div class="muted" style="font-size:13px">' +
      '被他人借用 ' + (a.borrowed || 0) + ' 次' + (pct(a.quota) ? ' · ' + esc(pct(a.quota)) : '') + '</div></div>' +
      badge(a) + act + '</div></div>'
  }).join('') : '<div class="empty">你还没有托管任何号</div>'
}

async function load() {
  const r = await fetch('/api/me')
  if (r.status === 401) {
    $('loading').style.display = 'none'
    $('login').style.display = 'block'
    return
  }
  me = await r.json()
  $('loading').style.display = 'none'
  $('panel').style.display = 'block'
  fillUsage(null)
  render()
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.reauth) { location.href = '/enroll'; return }
  const id = e.target.dataset.exit
  if (!id) return
  const reason = prompt('退出原因（可选）') ?? ''
  const r = await fetch('/api/exit-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: id, reason })
  })
  if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.message || '提交失败'); return }
  load()
})

$('loginbtn').onclick = async () => {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: $('keyin').value.trim() })
  })
  if (!r.ok) { $('loginerr').textContent = 'key 不对'; return }
  $('login').style.display = 'none'
  load()
}

$('addbtn').onclick = () => { location.href = '/enroll' }

$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.reload()
}

load()
</script>
</body>
</html>`
}

export function landingPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gpt-gw</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --bg:#fff; --ok:#0a7c53; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#999; --line:#2a2a2a; --bg:#111; --ok:#39d29a; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:560px; margin:0 auto; padding:64px 20px 80px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
  p.lede { color:var(--muted); margin:0 0 36px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:14px; }
  .card h2 { font-size:15px; margin:0 0 4px; }
  .card p { color:var(--muted); font-size:13px; margin:0 0 14px; }
  input { font:inherit; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); width:100%; }
  .row { display:flex; gap:8px; }
  button { font:inherit; padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--ok); border-color:var(--ok); color:#fff; }
  .err { color:#c0392b; font-size:13px; min-height:20px; margin:8px 0 0; }
</style>
</head>
<body>
<main>
  <h1>gpt-gw</h1>
  <p class="lede">把 ChatGPT 订阅号放进共享池，按需要分配给团队使用。</p>

  <div class="card">
    <h2>已经有 key</h2>
    <p>用网关发给你的 key 登录，查看托管状态和用量。</p>
    <div class="row">
      <input id="keyin" type="password" placeholder="gw_...">
      <button class="primary" id="loginbtn">登录</button>
    </div>
    <p class="err" id="err"></p>
  </div>

  <div class="card">
    <h2>第一次来</h2>
    <p>把你自己的 ChatGPT 号交进池子，同时获得一把 key——有这个号在用，你才能用别人的额度。</p>
    <button id="enrollbtn">开始交号</button>
  </div>
</main>
<script>
document.getElementById('loginbtn').onclick = async () => {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: document.getElementById('keyin').value.trim() })
  })
  if (r.ok) location.href = '/me'
  else document.getElementById('err').textContent = 'key 不对'
}
document.getElementById('keyin').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('loginbtn').click() })
document.getElementById('enrollbtn').onclick = () => { location.href = '/enroll' }
</script>
</body>
</html>`
}
