import { PRESETS, CYCLE } from './persona.js'

/**
 * 设置页：单文件、无外链、无 CDN，直接由插件自己的 HTTP 路由吐出。
 * 右键菜单「设置面板」会用默认浏览器打开它；页面只跟本机 127.0.0.1 通信。
 */
export function renderPage(origin) {
  const presetCards = CYCLE.map((key) => {
    const p = PRESETS[key]
    return `<label class="card">
      <input type="radio" name="preset" value="${key}">
      <span class="card-title">${p.label}</span>
      <span class="card-desc">${p.text}</span>
    </label>`
  }).join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 识屏设置</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#f6f7f9; --card:#fff; --muted:#6b7280; --line:#e5e7eb; --accent:#2f6fed; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eceff4; --bg:#15171b; --card:#1e2127; --muted:#98a2b3; --line:#2c313a; --accent:#6ea8ff; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 18px 60px; background:var(--bg); color:var(--fg); font: 15px/1.6 "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 22px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 18px 14px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
  .card { display: block; border: 1px solid var(--line); border-radius: 10px; padding: 12px; cursor: pointer; }
  .card input { margin-right: 6px; }
  .card-title { font-weight: 600; }
  .card-desc { display: block; color: var(--muted); font-size: 12.5px; margin-top: 6px; }
  .card:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .row { display: flex; align-items: center; gap: 10px; margin: 10px 0; flex-wrap: wrap; }
  .row > label { min-width: 132px; color: var(--muted); font-size: 13.5px; }
  input[type=text], textarea, select { background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font: inherit; }
  textarea { width: 100%; min-height: 74px; resize: vertical; }
  input[type=text] { flex: 1; min-width: 180px; }
  button { font: inherit; border-radius: 9px; padding: 9px 18px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: #d64545; border-color: #d64545; }
  .muted { color: var(--muted); font-size: 12.5px; }
  .mem { font-size: 13px; border-top: 1px dashed var(--line); padding: 8px 0; }
  #toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 9px 16px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: .95; }
</style>
</head>
<body>
<main>
  <h1>大肥鱼 · 识屏设置</h1>
  <div class="sub">这一页只写本机插件配置（${origin}），不会上传任何内容。</div>

  <section>
    <h2>说话风格</h2>
    <div class="cards" id="presets">${presetCards}</div>
    <div class="row" style="margin-top:14px">
      <label for="custom">自定义性格</label>
      <input type="text" id="custom" placeholder="例如：像实验室师兄，说话直接，会追问思路" maxlength="300">
    </div>
    <div class="row">
      <label for="address">怎么称呼你</label>
      <input type="text" id="address" placeholder="主人" maxlength="8">
    </div>
    <div class="row">
      <label for="forbid">不要聊</label>
      <input type="text" id="forbid" placeholder="例如：作息、健康、催我休息" maxlength="120">
    </div>
    <div class="muted">自定义写了内容就会切到「自定义」；隐私过滤和发言频率不受人设影响。</div>
  </section>

  <section>
    <h2>什么时候可以开口</h2>
    <div class="row">
      <label for="maxPerHour">每小时最多</label>
      <select id="maxPerHour"></select><span class="muted">次主动发言</span>
    </div>
    <div class="row">
      <label for="minGapMin">两次至少隔</label>
      <select id="minGapMin"></select><span class="muted">分钟</span>
    </div>
    <div class="row">
      <label for="bubbleMin">气泡停留</label>
      <select id="bubbleMin"></select><span class="muted">分钟；切到别的窗口会立刻收起</span>
    </div>
    <div class="row">
      <label for="night">夜间安静</label>
      <input type="checkbox" id="night">
      <span class="muted">23:00–07:00 不主动说话（手动识屏照常）</span>
    </div>
  </section>

  <section>
    <h2>识屏</h2>
    <div class="row">
      <label for="enabled">自动识屏</label>
      <input type="checkbox" id="enabled">
      <span class="muted">关掉后完全不截图</span>
    </div>
    <div class="row">
      <label for="interval">普通间隔</label>
      <input type="range" id="interval" min="30" max="300" step="10">
      <span id="intervalText" class="muted"></span>
    </div>
    <div class="muted">电池供电自动放慢到 180 秒，锁屏 / 空闲 / 高负载会自动暂停。</div>
  </section>

  <section>
    <h2>记忆</h2>
    <div class="row">
      <label for="memEnabled">记住长期信息</label>
      <input type="checkbox" id="memEnabled">
      <span class="muted">只存任务与进度，不存画面细节</span>
    </div>
    <div id="memList"></div>
    <div class="row" style="margin-top:8px">
      <button class="danger" id="clearMem">清空记忆</button>
    </div>
  </section>

  <div class="row" style="justify-content:flex-end">
    <button class="primary" id="save">保存设置</button>
  </div>
  <div id="toast"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
function toast(text) { const t = $('toast'); t.textContent = text; t.className = 'show'; setTimeout(() => { t.className = '' }, 2200) }
function fillSelect(el, from, to, step, suffix) {
  el.innerHTML = ''
  for (let v = from; v <= to; v += step) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = String(v) + (suffix || ''); el.appendChild(o)
  }
}
fillSelect($('maxPerHour'), 1, 3, 1)
fillSelect($('minGapMin'), 15, 120, 5)
fillSelect($('bubbleMin'), 5, 60, 5)
$('interval').addEventListener('input', () => { $('intervalText').textContent = $('interval').value + ' 秒' })

let state = null
async function load() {
  const r = await fetch('${origin}/dsh-pet-look/settings/state')
  state = await r.json()
  const p = state.persona
  const radio = document.querySelector('input[name=preset][value="' + p.preset + '"]')
  if (radio) radio.checked = true
  $('custom').value = p.custom || ''
  $('address').value = p.address && p.address !== '主人' ? p.address : ''
  $('forbid').value = p.forbid || ''
  $('maxPerHour').value = String(state.speak.maxPerHour)
  $('minGapMin').value = String(Math.round(state.speak.minGapSec / 60))
  $('bubbleMin').value = String(Math.max(5, Math.round(((state.bubble && state.bubble.durationMs) || 3600000) / 60000)))
  $('night').checked = !!state.speak.nightQuiet
  $('enabled').checked = !!state.enabled
  $('interval').value = String(state.intervals.normal)
  $('intervalText').textContent = state.intervals.normal + ' 秒'
  $('memEnabled').checked = !!state.memory.enabled
  const list = state.memory.items || []
  // 记忆文本来自模型对屏幕的转述，可能包含 <img onerror=...> 这类内容，
  // 因此只建 DOM 节点、用 textContent 填文字，绝不拼 HTML 字符串。
  const box = $('memList')
  box.textContent = ''
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = '还没有记住任何东西。'
    box.appendChild(empty)
  } else {
    for (const m of list) {
      const row = document.createElement('div')
      row.className = 'mem'
      row.textContent = (m.status === 'done' ? '✓ ' : '· ') + String(m.text || '')
      box.appendChild(row)
    }
  }
}
$('save').addEventListener('click', async () => {
  const picked = document.querySelector('input[name=preset]:checked')
  const body = {
    persona: {
      preset: picked ? picked.value : 'companion',
      custom: $('custom').value,
      address: $('address').value || '主人',
      forbid: $('forbid').value,
    },
    speak: { maxPerHour: Number($('maxPerHour').value), minGapSec: Number($('minGapMin').value) * 60, nightQuiet: $('night').checked },
    bubble: { durationMs: Number($('bubbleMin').value) * 60000 },
    enabled: $('enabled').checked,
    intervals: { normal: Number($('interval').value) },
    memory: { enabled: $('memEnabled').checked },
  }
  const r = await fetch('${origin}/dsh-pet-look/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (r.ok) { toast('已保存，桌宠立刻按新设置工作'); load() } else { toast('保存失败，看一下 DSH 是否还在运行') }
})
$('clearMem').addEventListener('click', async () => {
  if (!confirm('清空插件记住的长期信息？此操作不可撤销。')) return
  await fetch('${origin}/dsh-pet-look/memory', { method: 'DELETE' })
  toast('已清空'); load()
})
load().catch(() => toast('读不到设置，插件可能还没起来'))
</script>
</body>
</html>`
}
