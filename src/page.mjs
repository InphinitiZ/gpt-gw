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
    <input id="name" type="text" placeholder="zhangjs@company.com" autocomplete="username">
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
    <p class="ok">已加入共享池。</p>
    <div class="warn" id="unresolved" style="display:none">
      号已经入库，但没从 token 里解析出账号 id。先别拿去用，把 <code class="inline">data/last-device-token.json</code> 发给管理员。
    </div>
    <p class="hint">这是你的网关 key，只显示这一次：</p>
    <pre id="key"></pre>
    <p class="hint">写进 <code class="inline">~/.codex/config.toml</code>：</p>
    <pre id="cfg"></pre>
    <p class="hint">然后 <code class="inline">export GPT_GW_KEY=…</code> 就能用了。</p>
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
      <p>网关的出口 IP 被 Cloudflare 拦了，跑不了设备授权。改成在你自己的终端里跑：</p>
      <pre>codex login          # 用要上交的号登录
npx alpha-mind enroll     # 读取 ~/.codex/auth.json 并上传</pre>
      <p class="hint">在你自己机器上发起，走你的网络，不会被拦。</p>
    </div>
    <button id="retry" class="ghost">重试</button>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id)
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
    $('key').textContent = j.key
    $('cfg').textContent = [
      'model_provider = "alpha-mind"',
      '',
      '[model_providers.alpha-mind]',
      'name = "alpha-mind"',
      'base_url = "http://' + location.host + '/v1"',
      'env_key = "GPT_GW_KEY"',
      'wire_api = "responses"'
    ].join('\\n')
    show('s3')
  } else {
    fail(j)
  }
}

function fail(j) {
  clearInterval(timer)
  $('errmsg').textContent = j.message || '授权失败'
  $('fallback').style.display = j.challenge ? 'block' : 'none'
  show('s4')
}

$('go').onclick = start
$('retry').onclick = () => { $('st1').textContent = ''; show('s1') }
$('again').onclick = () => { $('st1').textContent = ''; show('s1') }
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })
</script>
</body>
</html>`
}
