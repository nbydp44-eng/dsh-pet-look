// 产品化改动的离线测试：人设、重复闸门、夜间安静、设置读写、记忆清空。
// 全部在本地跑，用假 llm/attachments 和一个假桌宠 HTTP 服务，不触碰真实屏幕。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'

const tmpHome = path.join(os.tmpdir(), 'look-product-home')
fs.rmSync(tmpHome, { recursive: true, force: true })
fs.mkdirSync(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

// —— 假桌宠服务：只接受广播与菜单轮询，记录所有气泡文本 ——
const bubbles = []
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  res.setHeader('content-type', 'application/json')
  if (url.pathname.endsWith('/broadcast')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { bubbles.push(JSON.parse(body).text) } catch {}
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }
  if (url.pathname.endsWith('/menu/events')) { res.end(JSON.stringify({ ok: true, events: {} })); return }
  if (url.pathname.endsWith('/menu/item')) { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => res.end(JSON.stringify({ ok: true }))); return }
  if (url.pathname.endsWith('/state')) { res.end(JSON.stringify({ ok: true, sections: { workStatus: { state: 'idle' } }, pets: {} })); return }
  res.end(JSON.stringify({ ok: true }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const routes = new Map()
const ctx = {
  get(name) {
    if (name === 'webServer') return { getOrigin: () => origin, register: (r) => { routes.set(`${r.path}`, r.handler); return () => routes.delete(r.path) } }
    return undefined
  },
  on() {},
}

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, 'lib', 'index.js')).href)
import { rules } from './lib/persona.js'
import { normalizeConfig } from './lib/config.js'
const api = apply(ctx, { enabled: false, debugRoutes: true, dataDir: tmpHome, speak: { maxPerHour: 3, minGapSec: 60 } })
const { _internals } = api

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const { persona, isRepeat, say, applySettings, settingsState, memory, canSpeak } = _internals

// —— 人设 ——
const start = persona.get()
check('persona-default-companion', start.preset === 'companion' && start.label === '体贴陪伴型', start.label)
check('persona-rules-no-nagging', /不劝睡/.test(persona.text()) === false && /不劝睡/.test(rules('主人')))

const order = []
for (let i = 0; i < 5; i += 1) order.push(persona.cycle().preset)
check('persona-cycle-five', order.join(',') === 'humor,analyst,chatty,observer,companion', order.join(','))

persona.set({ preset: 'friend' })
check('persona-alias-friend', persona.get().preset === 'companion')

persona.set({ custom: '像实验室师兄，说话直接，会追问思路', preset: 'custom' })
const custom = persona.get()
check('persona-custom-text', custom.preset === 'custom' && custom.text.includes('实验室师兄'), custom.label)

persona.set({ address: '阿泽', forbid: '作息、健康' })
const addressed = persona.get()
check('persona-address-forbid', addressed.text.includes('阿泽') && addressed.text.includes('作息'), addressed.text.slice(0, 40))

// 自定义内容不能顶掉硬规矩：规矩段落单独拼，不来自用户输入

check('persona-rules-independent', rules('阿泽').includes('不做生活管教') && !rules('阿泽').includes('实验室师兄'))

// 清掉自定义，回到预设
persona.set({ preset: 'analyst', custom: '' })
check('persona-clear-custom', persona.get().preset === 'analyst' && persona.get().custom === '')

// —— 夜间安静（放在任何发言之前，避免被频率上限干扰）——
const hour = new Date().getHours()
const inNight = hour >= 23 || hour < 7
check('can-speak-baseline', canSpeak() === true)
applySettings({ speak: { nightQuiet: true } })
check('night-quiet-blocks', inNight ? canSpeak() === false : canSpeak() === true, `hour=${hour}`)
applySettings({ speak: { nightQuiet: false } })
check('night-quiet-off', canSpeak() === true)

// —— 0.3.0：气泡长留、分析预算 ——
const cfg = api.config
check('bubble-default-long', cfg.bubble.durationMs === 3600000 && cfg.bubble.clearOnSwitch === true, String(cfg.bubble.durationMs))
check('analysis-budget-default', cfg.vision.maxPerHour === 24 && cfg.vision.maxTokens >= 800)
const budget = _internals.canAnalyze()
check('can-analyze-baseline', budget === true)

// —— 重复闸门 ——
bubbles.length = 0
check('say-first-ok', (await say('这段代码的循环条件写反了。')) === true, bubbles.join('|'))
check('say-repeat-blocked', (await say('这段代码的循环条件写反了。')) === false)
check('say-reword-blocked', (await say('这段代码的循环条件，写反了')) === false)
check('say-different-ok', (await say('矩阵的秩那题可以先做行变换。')) === true)
check('isRepeat-helper', isRepeat('矩阵的秩那题，可以先做行变换！') === true)
check('say-topic-said', (await say('第三章的秩学得挺扎实，行变换那步没卡住。', true)) === true)
check('repeat-paraphrase-topic', isRepeat('第三章的秩掌握得不错，思路很清晰。') === true)
check('repeat-new-topic-ok', isRepeat('这套视频在讲火锅店探店，看着挺香。') === false)


// —— 设置读写 ——
const applied = applySettings({
  persona: { preset: 'humor', address: '主人', custom: '', forbid: '' },
  speak: { maxPerHour: 5, minGapSec: 600, nightQuiet: false },
  intervals: { normal: 90 },
  memory: { enabled: false },
})
check('settings-applied-list', applied.includes('persona') && applied.includes('speak') && applied.includes('intervals'), applied.join(','))
const st = settingsState()
check('settings-state-values', st.persona.preset === 'humor' && st.speak.maxPerHour === 3 && st.speak.minGapSec === 900 && st.intervals.normal === 90, JSON.stringify(st.speak))
check('settings-memory-off', st.memory.enabled === false)

// 越界值要被夹住，而不是原样写进运行时
applySettings({ speak: { maxPerHour: 99, minGapSec: 1 }, intervals: { normal: 5 } })
const st2 = settingsState()
check('settings-clamped', st2.speak.maxPerHour === 3 && st2.speak.minGapSec === 900 && st2.intervals.normal === 30, JSON.stringify({ s: st2.speak, i: st2.intervals.normal }))

// 气泡停留：可调但必须落在 1–60 分钟内
applySettings({ bubble: { durationMs: 15 * 60000 } })
check('bubble-setting-applied', settingsState().bubble.durationMs === 900000, String(settingsState().bubble.durationMs))
applySettings({ bubble: { durationMs: 0 } })
check('bubble-setting-clamped', settingsState().bubble.durationMs === 60000, String(settingsState().bubble.durationMs))
applySettings({ bubble: { durationMs: 3600000 } })

// —— 记忆：只收合规内容，可清空 ——
check('memory-apply-ok', memory.apply({ key: 'task-1', text: '在写线性代数第三章的作业', status: 'active' }) === 'task-1')
check('memory-reject-card', memory.apply({ key: 'x', text: '银行卡 6222 0212 3456 7890' }) === null)
check('memory-list-has-item', memory.list().some((i) => i.key === 'task-1'))
const cleared = memory.clear()
check('memory-cleared', cleared.total === 0 && memory.list().length === 0)

// 过期记忆不再注入：否则桌宠会脱离屏幕、反复念叨上周的作业
const { createMemory } = await import(pathToFileURL(path.join(process.cwd(), 'lib/memory.js')).href)
const ttlDir = path.join(tmpHome, 'ttl')
fs.mkdirSync(ttlDir, { recursive: true })
const stale = Date.now() - 100 * 3600 * 1000
fs.writeFileSync(path.join(ttlDir, 'memory.json'), JSON.stringify({ version: 1, items: [{ key: 'old', text: '上周在写线性代数第三章的作业', status: 'active', createdAt: stale, updatedAt: stale }] }))
const ttlMemory = createMemory(ttlDir, { memory: { maxEntries: 10, injectEntries: 10, ttlHours: 72 } })
check('memory-ttl-filters-old', ttlMemory.activeList().length === 0)
const fresh = createMemory(ttlDir, { memory: { maxEntries: 10, injectEntries: 10, ttlHours: 0 } })
check('memory-ttl-zero-keeps-all', fresh.activeList().length === 1)

// —— 设置页路由：HTML + JSON 接口真的注册了 ——
const get = routes.get('/dsh-pet-look/settings')
check('route-settings-page', typeof get === 'function')
let pageHtml = ''
if (get) {
  await get({ method: 'GET' }, { setHeader() {}, end: (x) => { pageHtml = String(x) } })
  check('settings-page-html', pageHtml.includes('大肥鱼 · 识屏设置') && pageHtml.includes('name="preset"') && !/https?:\/\/(?!127\.0\.0\.1)/.test(pageHtml))
}
check('route-settings-state', typeof routes.get('/dsh-pet-look/settings/state') === 'function')
check('route-memory-delete', typeof routes.get('/dsh-pet-look/memory') === 'function')

// —— 本机路由边界：跨站、非回环 Host、非 JSON 写操作都要被拒 ——
const hit = async (method, headers, route = '/dsh-pet-look/settings', payload = '') => {
  const handler = routes.get(route)
  let code = 0
  let body = ''
  const res = {
    setHeader() {},
    set statusCode(v) { code = v },
    get statusCode() { return code },
    end(x) { body = String(x ?? '') },
  }
  await handler({
    method,
    headers,
    // 极简 req：readBody 只挂在 data/end/error 上，这里让 end 立即触发一次。
    on(event, cb) { if (event === 'data' && payload) queueMicrotask(() => cb(Buffer.from(payload))); if (event === 'end') queueMicrotask(() => cb()); return this },
    destroy() {},
  }, res)
  return { code, body }
}
const foreignHost = await hit('GET', { host: 'evil.example:2577' })
check('guard-foreign-host', foreignHost.code === 403, `code=${foreignHost.code}`)
const foreignOrigin = await hit('POST', { host: '127.0.0.1:2577', origin: 'http://evil.example', 'content-type': 'application/json' })
check('guard-foreign-origin', foreignOrigin.code === 403, `code=${foreignOrigin.code}`)
const crossSite = await hit('POST', { host: '127.0.0.1:2577', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })
check('guard-cross-site', crossSite.code === 403, `code=${crossSite.code}`)
const formPost = await hit('POST', { host: '127.0.0.1:2577', origin: 'http://127.0.0.1:2577', 'content-type': 'application/x-www-form-urlencoded' })
check('guard-form-post', formPost.code === 403, `code=${formPost.code}`)
const putMethod = await hit('PUT', { host: '127.0.0.1:2577', 'content-type': 'application/json' })
check('guard-method-405', putMethod.code === 405, `code=${putMethod.code}`)
// 同路径多方法：GET 与 POST 必须都能命中，不能被对方的注册盖掉（0.2.0 的 405 回归）
const personaGet = await hit('GET', { host: '127.0.0.1:2577' }, '/dsh-pet-look/persona')
check('route-persona-get', personaGet.code === 200 && JSON.parse(personaGet.body).ok === true, `code=${personaGet.code}`)
const personaPost = await hit('POST', { host: '127.0.0.1:2577', origin: 'http://127.0.0.1:2577', 'content-type': 'application/json' }, '/dsh-pet-look/persona', '{"preset":"humor"}')
check('route-persona-post', personaPost.code === 200 && JSON.parse(personaPost.body).persona.preset === 'humor', `code=${personaPost.code}`)

const sameOrigin = await hit('POST', { host: '127.0.0.1:2577', origin: 'http://127.0.0.1:2577', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
check('guard-same-origin-ok', sameOrigin.code === 200, `code=${sameOrigin.code}`)

// 静止画面的定时兜底：默认 10 分钟看一次，且配置里能把它调到合理区间。
const statusNow = await hit('GET', { host: '127.0.0.1:2577' }, '/dsh-pet-look/status')
const cfgNow = JSON.parse(statusNow.body)
check('heartbeat-default', cfgNow.bubble && cfgNow.bubble.durationMs === 3600000, 'bubble=60min')
const withHb = normalizeConfig({ vision: { heartbeatSec: 5 } })
check('heartbeat-clamped', withHb.vision.heartbeatSec === 120, `hb=${withHb.vision.heartbeatSec}`)

// 发言频率是硬上限：配置只能更克制，不能把「每小时 3 次 / 间隔 15 分钟」改得更吵。
const loud = normalizeConfig({ speak: { maxPerHour: 50, minGapSec: 30 } }).speak
check('speak-cap-hard', loud.maxPerHour === 3 && loud.minGapSec === 900, `max=${loud.maxPerHour} gap=${loud.minGapSec}`)
const calm = normalizeConfig({ speak: { maxPerHour: 2, minGapSec: 1800 } }).speak
check('speak-cap-keeps-calmer', calm.maxPerHour === 2 && calm.minGapSec === 1800, `max=${calm.maxPerHour} gap=${calm.minGapSec}`)

// 设置页把记忆文本当文本插入，不能拼 HTML（记忆内容来自模型对屏幕的转述）。
const page = pageHtml
check('settings-page-no-html-injection', page.includes('row.textContent') && !page.includes('innerHTML = list.length'), 'memList uses textContent')

// 说话同时写进桌宠自己的对话记忆：用户点开对话能接上，且不产生模型调用。
const { createPet } = await import('./lib/pet.js')
const petDir = path.join(tmpHome, 'dsh-pet')
fs.mkdirSync(petDir, { recursive: true })
const petMem = path.join(petDir, 'memory.json')
fs.writeFileSync(petMem, JSON.stringify({ main: { main: { messages: [] } } }))
const oldTime = new Date(Date.now() - 30_000)
fs.utimesSync(petMem, oldTime, oldTime)
const chatPet = createPet(ctx, normalizeConfig({ dataDir: tmpHome }))
const wrote = await chatPet.noteAssistant('这段 grid 少了一列，右边那栏掉下去了。')
const memAfter = JSON.parse(fs.readFileSync(petMem, 'utf8'))
check('chat-note-appended', wrote === true && memAfter.main.main.messages.at(-1).content.includes('grid'), JSON.stringify(memAfter.main.main.messages.slice(-1)))
check('chat-note-role', memAfter.main.main.messages.at(-1).role === 'assistant')
const blocked = await chatPet.noteAssistant('紧接着又说一句')
check('chat-note-skip-while-fresh', blocked === false, '刚写过记忆时让位给真对话')
fs.utimesSync(petMem, oldTime, oldTime)
const dup = await chatPet.noteAssistant('这段 grid 少了一列，右边那栏掉下去了。')
check('chat-note-dedupe', dup === false, '同一句不重复写')
check('chat-note-backup', fs.existsSync(`${petMem}.bak`), 'memory.json.bak')
// 用户还没开口时连续说话：只保留最新一条，别把历史堆成独白。
fs.utimesSync(petMem, oldTime, oldTime)
const beforeLen = JSON.parse(fs.readFileSync(petMem, 'utf8')).main.main.messages.length
const replaced = await chatPet.noteAssistant('画面换成浏览器里的接口文档了。')
const afterMsgs = JSON.parse(fs.readFileSync(petMem, 'utf8')).main.main.messages
check('chat-note-collapses-monologue', replaced === true && afterMsgs.length === beforeLen && afterMsgs.at(-1).content.includes('接口文档'), `len ${beforeLen}->${afterMsgs.length}`)

// 临时图保留窗口：默认 5 分钟，可以调成 0（立刻删）或更长。
check('temp-keep-default', normalizeConfig({}).privacy.tempKeepSec === 300, String(normalizeConfig({}).privacy.tempKeepSec))
check('temp-keep-zero', normalizeConfig({ privacy: { tempKeepSec: 0 } }).privacy.tempKeepSec === 0)
check('temp-keep-clamped', normalizeConfig({ privacy: { tempKeepSec: 99999 } }).privacy.tempKeepSec === 3600)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
server.close()
process.exit(failed.length ? 1 : 0)
