import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from './config.js'
import { hamming, localDay, sleep } from './util.js'
import { capturePrimaryScreen, privacyGate, systemStatus, foregroundKey, dropFile, sweepScratch } from './capture.js'
import { createVision } from './vision.js'
import { createMemory } from './memory.js'
import { createLogger } from './logger.js'
import { createPet } from './pet.js'
import { createMenu } from './menu.js'
import { createPersona } from './persona.js'
import { renderPage } from './settings-page.js'
import { evaluate, needsLook } from './decide.js'
import { spawn } from 'node:child_process'

export const name = 'dsh-pet-look'

// webServer 是硬依赖：宿主在启动早期就可能调用 apply，此时服务尚未挂载，
// 用 ctx.get('webServer') 会拿到 undefined，路由就再也注册不上。
export const inject = ['webServer']

const SILENT_SCENES = new Set(['chat', 'payment'])
// 宿主自己的窗口就是一个对话界面：用户在跟我聊天，桌宠不该去点评对话正文。
// IM 类进程已由 SYS 脚本打成 chat 标签，这里补上宿主进程名。
const CHAT_PROC = /^(DeepSeek Harness|微信|WeChat|QQ|Telegram|Discord|Slack|Lark|飞书|钉钉|WhatsApp)$/i
// 只有这些原因才说明「视觉服务本身不可用」；空回复、解析失败、超时都是单次调用的偶发结果，
// 不足以给整条路由判死刑，否则会误导用户去改配置。
const ROUTE_BROKEN = new Set([
  'llm-unavailable',
  'no-vision-route',
  'configured-model-no-image',
  'configured-model-unavailable',
  'attachments-unavailable',
])

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = config.dataDir || path.join(dshHome, 'dsh-pet-look')
  try { fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true }) } catch {}

  const logger = createLogger(dataDir, config.logs.keepDays)
  const memory = createMemory(dataDir, config)
  const pet = createPet(ctx, config)
  const vision = createVision(ctx, config, logger)
  const menu = createMenu(pet, logger)
  const persona = createPersona(dataDir, config)

  const state = {
    autoOn: config.enabled === true,
    manualPaused: false,
    smartPause: '',
    running: false,
    intervalSec: config.intervals.normal,
    lastCaptureAt: 0,
    lastAnalysisAt: 0,
    lastHash: '',
    lastText: '',
    lastScene: '',
    lastSpeakAt: 0,
    speakTimes: [],
    recent: [],
    manualCoolUntil: 0,
    last: { at: 0, ok: null, code: '' },
    lastDecision: null,
    visionRoute: { ok: false, reason: 'unresolved' },
    scene: 'other',
    system: null,
    /** 最近一小时真正发出去的模型调用（用来防同一画面反复问模型）。 */
    analysisTimes: [],
    /** 当前气泡：展示时刻与当时的前台窗口，用于窗口切换后智能收起。 */
    bubble: { at: 0, key: '' },
  }

  let disposed = false
  let timer = null
  let bubbleTimer = null

  function schedule(seconds) {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { tick().catch(() => {}) }, Math.max(5, seconds) * 1000)
  }

  function logEvent(ok, ms, code) {
    state.last = { at: Date.now(), ok, code }
    logger.event({ ok, ms, code })
  }

  function pickInterval(sys) {
    let iv = config.intervals.normal
    const dynamic = state.scene === 'game' || state.scene === 'video' ||
      sys.tags.includes('game') || sys.tags.includes('video')
    if (dynamic) iv = Math.max(iv, config.intervals.dynamic)
    if (sys.onAC === false) iv = Math.max(iv, config.intervals.battery)
    if (sys.load !== null && sys.load >= config.load.slowAbove) iv = Math.max(iv, config.intervals.slow)
    return iv
  }

  function canSpeak() {
    const now = Date.now()
    state.speakTimes = state.speakTimes.filter((t) => now - t < 3600 * 1000)
    if (state.speakTimes.length >= config.speak.maxPerHour) return false
    if (state.lastSpeakAt && now - state.lastSpeakAt < config.speak.minGapSec * 1000) return false
    // 夜间安静：只是不主动开口，手动识屏仍然照常回应。
    const nq = config.speak.nightQuiet
    if (nq && nq.enabled) {
      const h = new Date().getHours()
      const inRange = nq.from <= nq.to ? (h >= nq.from && h < nq.to) : (h >= nq.from || h < nq.to)
      if (inRange) return false
    }
    return true
  }

  /**
   * 模型调用预算：每小时最多 N 次真正的视觉分析。
   * 它管的是「问模型的次数」，不是「说话的次数」——同屏反复分析最费 Token。
   */
  function canAnalyze() {
    const now = Date.now()
    state.analysisTimes = state.analysisTimes.filter((t) => now - t < 3600 * 1000)
    return state.analysisTimes.length < config.vision.maxPerHour
  }

  /** 归一化后再比较：标点、空格不同不算不同的话。 */
  function normalizeSay(text) {
    return String(text || '').replace(/[\s，。！？、,.!?~～…"'“”‘’：:；;（）()【】\[\]]/g, '')
  }

  function bigrams(text) {
    const s = normalizeSay(text)
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }

  /** 连续 4 字的片段：中文里足以指认「在说同一件事」，又不会被换个说法绕开。 */
  function grams4(text) {
    const s = normalizeSay(text)
    const set = new Set()
    for (let i = 0; i + 4 <= s.length; i += 1) set.add(s.slice(i, i + 4))
    return set
  }

  function sharesGram(a, b) {
    const A = grams4(a)
    if (!A.size) return false
    const B = grams4(b)
    for (const g of A) if (B.has(g)) return true
    return false
  }

  /**
   * 两句话的二元组重合度（0 = 毫无关系，1 = 一模一样）。
   * 只抓字面重复是不够的：同一个话题换个说法反复说，正是「总在念同一件事」的来源。
   */
  function overlap(a, b) {
    const A = bigrams(a)
    const B = bigrams(b)
    if (!A.size || !B.size) return 0
    let hit = 0
    for (const g of A) if (B.has(g)) hit += 1
    return hit / Math.min(A.size, B.size)
  }

  /**
   * 重复闸门：模型并不知道自己刚说过什么，只靠提示词约束不住。
   * 最近三条里出现相同、一方包含另一方，或换个说法仍在聊同一个话题，都当作重复。
   */
  function isRepeat(text) {
    const n = normalizeSay(text)
    if (!n) return true
    return state.recent.slice(-3).some((prev) => {
      const q = normalizeSay(prev)
      if (!q) return false
      if (q === n) return true
      const [short, long] = q.length <= n.length ? [q, n] : [n, q]
      if (short.length >= 6 && long.includes(short)) return true
      // 长句才算话题重复；太短的句子（「好呀」「嗯」）重合度高也不该被判重。
      if (n.length < 8 || q.length < 8) return false
      if (sharesGram(n, q)) return true
      return overlap(n, q) >= 0.4
    })
  }

  function noteSpeak(text, kind = 'auto') {
    state.lastSpeakAt = Date.now()
    state.speakTimes.push(state.lastSpeakAt)
    if (text) {
      state.recent.push(String(text))
      if (state.recent.length > 6) state.recent.shift()
    }
    logger.spoke(kind)
  }

  /** 气泡长留 + 切换窗口自动收起：收起只调本地 HTTP，不再问模型。 */
  function stopBubbleWatch() {
    if (bubbleTimer) { clearInterval(bubbleTimer); bubbleTimer = null }
  }

  function startBubbleWatch(key) {
    stopBubbleWatch()
    state.bubble = { at: Date.now(), key: key || '' }
    if (!config.bubble.clearOnSwitch || !key) return
    const shownAt = Date.now()
    const lifeMs = config.bubble.durationMs
    bubbleTimer = setInterval(async () => {
      if (disposed) { stopBubbleWatch(); return }
      if (Date.now() - shownAt > lifeMs) { stopBubbleWatch(); return }
      const now = await foregroundKey().catch(() => null)
      if (!now) return
      if (now !== key) {
        await pet.clearBubble().catch(() => false)
        state.bubble = { at: 0, key: '' }
        stopBubbleWatch()
      }
    }, 10000)
    if (typeof bubbleTimer.unref === 'function') bubbleTimer.unref()
  }

  /** 临时图不立刻删：气泡还挂着时保留一小会儿，超时再清理（0 = 立刻删）。 */
  function dropLater(file, delayMs = config.privacy.tempKeepSec * 1000) {
    if (!file) return
    if (!(delayMs > 0)) { dropFile(file); return }
    const timer = setTimeout(() => dropFile(file), delayMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function say(text, allowRepeat = false, kind = 'auto') {
    if (!text) return false
    if (!allowRepeat && isRepeat(text)) return false
    // 说之前先记下当时的前台窗口，之后它一变就收起气泡。
    const key = await foregroundKey().catch(() => null)
    const ok = await pet.broadcast(text)
    if (ok) {
      noteSpeak(text, kind)
      startBubbleWatch(key)
      // 同步进桌宠自己的对话记忆：用户点开「对话」接着聊时，它知道刚才说过这句。
      // 纯本地读写，不产生模型调用。
      pet.noteAssistant(text).catch(() => false)
    }
    return ok
  }

  function smartPauseReason(sys) {
    if (sys.locked) return 'locked'
    if (sys.idleSec > config.idlePauseSec) return 'idle'
    if (sys.load !== null && sys.load >= config.load.pauseAbove) return 'load'
    if (sys.tempC !== null && sys.tempC >= config.temp.pauseAbove) return 'temp'
    return ''
  }

  /**
   * 自动识屏的一次分析。返回 { ok, code } 由 tick() 统一记账（每次截图只记一条）。
   * 任何失败都只是安静返回，不重试、不打扰。
   */
  async function analyzeAuto(cap, sys, cleanup = []) {
    const dist = state.lastHash ? hamming(cap.hash, state.lastHash) : 64
    // 变化检测与静止兜底都放在 lib/decide.js（纯函数，可测）。
    const look = needsLook({
      dist: state.lastHash ? dist : 64,
      lastAnalysisAt: state.lastAnalysisAt,
      change: config.change,
      heartbeatSec: config.vision.heartbeatSec,
    })
    if (!look.look) return { ok: true, code: 'unchanged' }
    if (sys.tags.includes('risky')) {
      // 记住这一帧：同类敏感界面不再反复 OCR / 反复判断。
      state.lastHash = cap.hash
      return { ok: true, code: 'risky-app' }
    }
    // 预算耗尽时不再截图分析，等到下一个周期；不补做、不攒着连发。
    if (!canAnalyze()) return { ok: true, code: 'budget' }

    const gate = await privacyGate(cap.path, config.privacy.maxMatchedLineRatio, config.privacy.softBlockAt)
    if (!gate.ok) return { ok: false, code: `privacy-${gate.reason}` }
    // 脱敏副本是另一个临时文件，交给 tick 在本次分析结束后一并销毁。
    if (gate.path && gate.path !== cap.path) cleanup.push(gate.path)
    if (gate.verdict === 'blocked') {
      state.lastHash = cap.hash
      logger.count('privacySkips')
      return { ok: true, code: 'privacy-blocked' }
    }

    state.analysisTimes.push(Date.now())
    logger.count('analyses')
    const res = await vision.analyze({
      imagePath: gate.path,
      sceneHint: gate.verdict === 'redacted' ? 'redacted' : 'auto',
      tags: sys.tags,
      proc: sys.proc,
      memories: config.memory.enabled ? memory.activeList() : [],
      manual: false,
      persona: persona.text(),
      address: persona.get().address,
      recent: state.recent.slice(-4),
      silenceMin: state.lastSpeakAt ? Math.round((Date.now() - state.lastSpeakAt) / 60000) : 999,
    })
    if (!res.ok) {
      // 空回复/截断只是「这一次没说完整」，不代表视觉服务坏了：不推翻已确认的路由，
      // 否则会把「模型没说完」误报成「视觉服务没配好」，用户看到的就是错误结论。
      if (ROUTE_BROKEN.has(res.reason)) state.visionRoute = { ok: false, reason: res.reason }
      if (res.reason === 'truncated') logger.count('truncated')
      return { ok: false, code: `vision-${res.reason || 'error'}` }
    }
    state.visionRoute = { ok: true, provider: res.provider, model: res.model }
    if (res.memory && config.memory.enabled) memory.apply(res.memory)
    state.lastAnalysisAt = Date.now()
    state.lastHash = cap.hash
    state.lastText = res.text
    state.lastScene = res.scene
    state.scene = res.scene

    const silent = SILENT_SCENES.has(res.scene) || sys.tags.includes('chat') || CHAT_PROC.test(String(sys.proc || ''))
    // 人设只微调门槛，不越过每小时上限与最小间隔。
    const threshold = Math.min(0.95, Math.max(0.2, config.speak.minConfidence + persona.get().speakBias))
    // 判定规则集中在 lib/decide.js，便于测试与解释（含「写了话却标 false」的兼容）。
    const verdict = evaluate(res, { threshold, silent })
    const { confident, codeOk, otherOk } = verdict
    const floor = verdict.floor
    // 只记结论与阈值比较，不记任何屏幕文字：诊断够了，隐私不降级。
    const decided = (code) => {
      state.lastDecision = {
        at: Date.now(), code, scene: res.scene, confidence: res.confidence,
        speak: res.speak === true, textLen: String(res.text || '').length,
        threshold, floor, confident, codeOk, otherOk, silent,
      }
      return { ok: true, code }
    }
    if (verdict.ok) {
      // 频率上限只挡发言，不挡分析：先判断「想说但被限流」，再判断「这句话刚说过」。
      if (!canSpeak()) {
        logger.count('held')
        return decided('held')
      }
      if (isRepeat(res.text)) {
        logger.count('repeat')
        return decided('repeat')
      }
      const spoke = await say(res.text, false, 'auto')
      if (!spoke) logger.count('sayFailed')
      state.lastDecision = {
        at: Date.now(), code: spoke ? 'spoke' : 'say-failed', scene: res.scene, confidence: res.confidence,
        speak: true, textLen: String(res.text || '').length, threshold, floor, confident, codeOk, otherOk, silent,
      }
      return { ok: spoke, code: spoke ? 'spoke' : 'say-failed' }
    }
    logger.count(verdict.wantsSpeak ? 'held' : 'quiet')
    return decided(verdict.wantsSpeak ? 'held' : 'quiet')
  }

  /** 一次自动识屏决策。返回前总排好下一次调度。 */
  async function tick() {
    if (disposed) return
    if (!state.autoOn || state.manualPaused) {
      state.smartPause = state.manualPaused ? 'manual' : ''
      schedule(config.pausedPollSec)
      return
    }

    const sys = await systemStatus()
    state.system = sys
    state.smartPause = smartPauseReason(sys)
    if (state.smartPause) { schedule(config.pausedPollSec); return }

    if (pet.chatting()) { schedule(45); return }
    if (state.running) { schedule(15); return }
    if (await pet.agentBusy()) { schedule(60); return }

    state.intervalSec = pickInterval(sys)
    const now = Date.now()
    if (now < state.manualCoolUntil) { schedule(Math.ceil((state.manualCoolUntil - now) / 1000)); return }
    if (now - state.lastCaptureAt < state.intervalSec * 1000) {
      schedule(Math.ceil((state.intervalSec * 1000 - (now - state.lastCaptureAt)) / 1000))
      return
    }

    state.lastCaptureAt = now
    const started = Date.now()
    const cap = await capturePrimaryScreen(config.vision.maxWidth)
    if (!cap.ok) {
      logEvent(false, Date.now() - started, `capture-${cap.reason}`)
      schedule(state.intervalSec)
      return
    }
    state.running = true
    let code = 'error'
    let ok = false
    // 一次分析可能产生两个临时文件：原始截图与脱敏副本。两个都要在这次分析结束后销毁。
    const cleanup = []
    try {
      const r = await analyzeAuto(cap, sys, cleanup)
      ok = r.ok
      code = r.code
    } catch (error) {
      code = 'analyze-failed'
    } finally {
      dropLater(cap.path)
      for (const file of cleanup) dropLater(file)
      state.running = false
    }
    logEvent(ok, Date.now() - started, code)
    // 菜单里的间隔/最近时间/今日计数跟着刷新；标签没变时 register 内部直接跳过。
    refreshMenu()
    // 视觉服务不可用时放慢节奏，别每轮都重试；恢复后仍按正常周期继续。
    schedule(String(code).startsWith('vision-') ? config.intervals.slow : state.intervalSec)
  }

  /** 手动识屏：优先级高于自动；不打断宠物聊天；与上次画面去重。 */
  async function manual(origin = 'menu') {
    const started = Date.now()
    const done = (ok, code, result) => {
      logEvent(ok, Date.now() - started, code)
      return { ok: false, reason: code, ...(result || {}) }
    }
    if (state.running) {
      await pet.broadcast('我还在看上一张，稍等一下下。')
      return done(true, 'manual-busy')
    }
    if (state.manualPaused && !config.allowManualWhilePaused) {
      await pet.broadcast('自动识屏现在是暂停的，先右键开启再让我看吧。')
      return done(true, 'manual-paused')
    }
    state.running = true
    // 与自动路径一致：原始截图、脱敏副本都在本次手动识屏结束时销毁。
    const cleanup = []
    try {
      // 正在聊天：等聊完（最多 2 分钟），绝不打断。
      for (let i = 0; i < 24 && pet.chatting(); i += 1) await sleep(5000)
      if (pet.chatting()) {
        await pet.broadcast('主人先聊完，我再看屏幕好不好。')
        return done(true, 'manual-deferred')
      }
      const cap = await capturePrimaryScreen(config.vision.maxWidth)
      if (!cap.ok) return done(false, `manual-capture-${cap.reason}`)
      try {
        if (state.lastHash && hamming(cap.hash, state.lastHash) <= config.dedupe.hashDistance &&
            Date.now() - state.lastAnalysisAt < config.dedupe.windowSec * 1000) {
          // 去重提示是「同一句话」的重复，直接投气泡，不走重复闸门、不计入发言次数。
          await pet.broadcast(state.lastText || '主人，这个画面和刚才一样，我暂时没有新的发现。')
          return done(true, 'manual-dedupe', { ok: true, deduped: true })
        }
        const sys = state.system || await systemStatus()
        if (sys.locked) return done(true, 'manual-locked')
        if (sys.tags.includes('risky')) {
          await pet.broadcast('这个界面看起来涉及隐私或支付，我就不看了。')
          return done(true, 'manual-risky')
        }
        const gate = await privacyGate(cap.path, config.privacy.maxMatchedLineRatio, config.privacy.softBlockAt)
        if (!gate.ok) {
          await pet.broadcast('本地隐私检测没跑起来，为了安全我先不看了。')
          return done(false, `privacy-${gate.reason}`)
        }
        // 脱敏副本与原始截图一样，只服务这一次分析。
        if (gate.path && gate.path !== cap.path) cleanup.push(gate.path)
        if (gate.verdict === 'blocked') {
          await pet.broadcast('屏幕上好像有敏感信息，我先不看了。')
          return done(true, 'privacy-blocked')
        }
        const res = await vision.analyze({
          imagePath: gate.path,
          sceneHint: 'manual',
          tags: sys.tags,
          proc: sys.proc,
          memories: config.memory.enabled ? memory.activeList() : [],
          manual: true,
          persona: persona.text(),
          address: persona.get().address,
          recent: state.recent.slice(-4),
        })
        if (!res.ok) {
          // 「这次没看清」和「视觉服务不可用」是两回事，别把前者说成后者。
          if (ROUTE_BROKEN.has(res.reason)) {
            state.visionRoute = { ok: false, reason: res.reason }
            await pet.broadcast('我这边看不了图（视觉服务还没配好），先记下来啦。')
          } else {
            await pet.broadcast('这次没看清屏幕上的内容，等下再看。')
          }
          return done(false, `vision-${res.reason || 'error'}`)
        }
        state.visionRoute = { ok: true, provider: res.provider, model: res.model }
        if (res.memory && config.memory.enabled) memory.apply(res.memory)
        state.lastAnalysisAt = Date.now()
        state.lastHash = cap.hash
        state.lastText = res.text
        state.lastScene = res.scene
        state.scene = res.scene
        state.manualCoolUntil = Date.now() + config.manualCooldownSec * 1000
        await say(res.text || '主人，我在呢。', true, 'manual')
        return done(true, 'manual-ok', { ok: true, text: res.text })
      } finally {
        dropLater(cap.path)
        for (const file of cleanup) dropLater(file)
      }
    } finally {
      state.running = false
    }
  }

  function status(extra = {}) {
    return {
      ok: true,
      autoOn: state.autoOn,
      manualPaused: state.manualPaused,
      smartPause: state.smartPause,
      intervalSec: state.intervalSec,
      running: state.running,
      scene: state.scene,
      lastCaptureAt: state.lastCaptureAt,
      lastAnalysisAt: state.lastAnalysisAt,
      last: state.last,
      lastDecision: state.lastDecision,
      stats: logger.snapshot(),
      bubble: { active: Boolean(state.bubble && state.bubble.at), at: state.bubble ? state.bubble.at : 0, durationMs: config.bubble.durationMs },
      budget: { usedLastHour: state.analysisTimes.filter((at) => Date.now() - at < 3600 * 1000).length, maxPerHour: config.vision.maxPerHour },
      memory: memory.snapshot(),
      persona: persona.get(),
      vision: state.visionRoute,
      system: state.system ? {
        idleSec: state.system.idleSec,
        locked: state.system.locked,
        proc: state.system.proc,
        tags: state.system.tags,
        onAC: state.system.onAC,
        battery: state.system.battery,
        load: state.system.load,
        tempC: state.system.tempC,
      } : null,
      ...extra,
    }
  }

  function statusLine() {
    const st = logger.snapshot()
    const when = state.lastCaptureAt ? new Date(state.lastCaptureAt).toTimeString().slice(0, 5) : '—'
    const mode = state.autoOn
      ? (state.manualPaused ? '已暂停（手动）' : state.smartPause ? `已暂停（${state.smartPause}）` : '开启')
      : '关闭'
    return `自动识屏${mode}｜间隔 ${state.intervalSec} 秒｜最近 ${when}｜今日 ${st.total} 次（成功 ${st.ok} / 失败 ${st.fail}）`
  }

  async function refreshMenu() {
    const st = logger.snapshot()
    const lastTime = state.lastCaptureAt ? new Date(state.lastCaptureAt).toTimeString().slice(0, 5) : '—'
    try {
      await menu.register(menu.currentLabels(state.autoOn, {
        intervalSec: state.intervalSec,
        lastTime,
        total: st.total,
        ok: st.ok,
        fail: st.fail,
        persona: persona.label(),
      }))
    } catch {}
  }

  async function toggleAuto() {
    state.autoOn = !state.autoOn
    state.manualPaused = !state.autoOn
    await refreshMenu()
    if (state.autoOn) schedule(3)
    await pet.broadcast(state.autoOn ? '自动识屏开啦，我会偶尔看看屏幕。' : '自动识屏先暂停，想让我看的时候再点我。')
    return state.autoOn
  }

  /** 菜单里点「人设」：按顺序轮到下一个并落盘；换人用这台电脑时各有一份。 */
  async function cyclePersona() {
    const next = persona.cycle()
    await refreshMenu()
    await pet.broadcast(`人设换成「${next.label}」了。`)
    return next
  }

  /** 菜单里点「设置面板」：用默认浏览器打开本机设置页。 */
  function openSettings() {
    const ws = ctx.get('webServer')
    const url = `${ws ? ws.getOrigin() : 'http://127.0.0.1:4254'}/dsh-pet-look/settings`
    try {
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch {}
    return url
  }

  /** 设置页要的当前值：只含配置与统计，不含屏幕内容。 */
  function settingsState() {
    const route = state.visionRoute
    return {
      ok: true,
      enabled: state.autoOn,
      persona: persona.get(),
      speak: {
        maxPerHour: config.speak.maxPerHour,
        minGapSec: config.speak.minGapSec,
        nightQuiet: config.speak.nightQuiet.enabled,
        minConfidence: config.speak.minConfidence,
        maxChars: config.speak.maxChars,
      },
      intervals: { ...config.intervals },
      bubble: { durationMs: config.bubble.durationMs, clearOnSwitch: config.bubble.clearOnSwitch },
      privacy: { enabled: config.privacy.enabled, softBlockAt: config.privacy.softBlockAt },
      memory: { enabled: config.memory.enabled, ...memory.snapshot(), items: memory.list(20) },
      vision: route && route.ok ? { ok: true, provider: route.provider, model: route.model } : { ok: false, reason: (route && route.reason) || 'pending' },
      settingsUrl: `${(ctx.get('webServer') || {}).getOrigin ? ctx.get('webServer').getOrigin() : ''}/dsh-pet-look/settings`,
    }
  }

  /** 网页保存后立刻生效：不重启、不重载插件。 */
  function applySettings(patch) {
    const p = patch && typeof patch === 'object' ? patch : {}
    const applied = []
    if (p.persona && typeof p.persona === 'object') { persona.set(p.persona); applied.push('persona') }
    if (p.speak && typeof p.speak === 'object') {
      const s = p.speak
      if (Number.isFinite(s.maxPerHour)) config.speak.maxPerHour = Math.max(1, Math.min(3, Math.round(s.maxPerHour)))
      if (Number.isFinite(s.minGapSec)) config.speak.minGapSec = Math.max(900, Math.min(21600, Math.round(s.minGapSec)))
      if (typeof s.nightQuiet === 'boolean') config.speak.nightQuiet.enabled = s.nightQuiet
      applied.push('speak')
    }
    if (typeof p.enabled === 'boolean') {
      state.autoOn = p.enabled
      state.manualPaused = !p.enabled
      applied.push('enabled')
    }
    if (p.intervals && Number.isFinite(p.intervals.normal)) {
      config.intervals.normal = Math.max(30, Math.min(300, Math.round(p.intervals.normal)))
      applied.push('intervals')
    }
    if (p.memory && typeof p.memory.enabled === 'boolean') { config.memory.enabled = p.memory.enabled; applied.push('memory') }
    if (p.bubble && Number.isFinite(p.bubble.durationMs)) {
      config.bubble.durationMs = Math.max(60000, Math.min(3600000, Math.round(p.bubble.durationMs)))
      applied.push('bubble')
    }
    refreshMenu()
    schedule(2)
    return applied
  }

  function onMenuEvent(label) {
    if (label.startsWith('自动识屏')) return toggleAuto()
    if (label === '立即识屏') return manual('menu')
    if (label.startsWith('人设')) return cyclePersona()
    if (label === '设置面板') return openSettings()
    if (label.startsWith('状态')) return pet.broadcast(statusLine())
    if (label.startsWith('今日')) {
      const st = logger.snapshot()
      return pet.broadcast(`今日检查 ${st.total} 次（成功 ${st.ok} / 失败 ${st.fail}），模型分析 ${st.analyses} 次，主动开口 ${st.autoSpeaks} 次。`)
    }
    return undefined
  }

  /** 本地诊断/测试路由：只回状态与统计，不含任何屏幕内容。 */
  function registerRoutes() {
    const ws = ctx.get('webServer')
    if (!ws || config.debugRoutes !== true) return null
    const disposers = []
    const json = (res, code, body) => {
      try {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(body))
      } catch {}
    }
    // 只读一小段 JSON：人设接口的 body 最多几百字节，绝不把大请求读进来。
    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 8192) { raw = ''; try { req.destroy() } catch {} }
      })
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
    // 本机路由的边界，不依赖「监听 127.0.0.1 就安全」这个假设：
    // 1) Host 必须是回环名，挡住 DNS rebinding（攻击者域名解析到 127.0.0.1）；
    // 2) Sec-Fetch-Site 只能是 same-origin/none，Origin 若存在必须是回环，挡住跨站表单与脚本；
    // 3) 写操作必须是 application/json，挡住 text/plain、form-urlencoded 这类免预检的简单请求。
    // 没有 Origin/Sec-Fetch-Site 的请求（curl、脚本）放行——它们本来就是本机用户权限。
    const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
    const hostOf = (value) => {
      try { return String(new URL(String(value)).hostname).replace(/^\[|\]$/g, '') } catch { return '' }
    }
    const allow = (req, mutating) => {
      const headers = (req && req.headers) || {}
      const host = String(headers.host || '127.0.0.1').split(':')[0].replace(/^\[|\]$/g, '')
      if (!LOOPBACK.has(host)) return false
      const site = headers['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') return false
      const origin = headers.origin
      if (origin && !LOOPBACK.has(hostOf(origin))) return false
      if (mutating) {
        const type = String(headers['content-type'] || 'application/json').split(';')[0].trim().toLowerCase()
        if (type !== 'application/json') return false
      }
      return true
    }
    const add = (method, route, handler) => {
      try {
        disposers.push(ws.register({
          kind: 'exact',
          path: route,
          handler: async (req, res) => {
            if (!allow(req, method !== 'GET')) { json(res, 403, { ok: false, error: 'forbidden' }); return }
            if (req.method !== method) { res.setHeader('Allow', method); json(res, 405, { ok: false }); return }
            try { json(res, 200, await handler(req)) } catch (error) { json(res, 500, { ok: false, error: String(error && error.message) }) }
          },
        }))
      } catch {}
    }
    // 一个 exact 路由只能挂一个 handler，所以「同路径多方法」必须在一个 handler 里分发。
    // 0.2.0 的 /persona 与 /settings 都踩过这个坑：后注册的会把先注册的盖掉，表现为 405。
    const addMethods = (route, table) => {
      try {
        disposers.push(ws.register({
          kind: 'exact',
          path: route,
          handler: async (req, res) => {
            const method = String(req.method || 'GET').toUpperCase()
            const handler = table[method]
            if (!allow(req, method !== 'GET')) { json(res, 403, { ok: false, error: 'forbidden' }); return }
            if (!handler) { res.setHeader('Allow', Object.keys(table).join(', ')); json(res, 405, { ok: false }); return }
            try { json(res, 200, await handler(req)) } catch (error) { json(res, 500, { ok: false, error: String(error && error.message) }) }
          },
        }))
      } catch {}
    }
    add('GET', '/dsh-pet-look/status', () => status())
    add('POST', '/dsh-pet-look/trigger', async () => {
      manual('http').catch(() => {})
      return { ok: true, accepted: true }
    })
    add('POST', '/dsh-pet-look/toggle', async () => ({ ok: true, autoOn: await toggleAuto() }))
    add('GET', '/dsh-pet-look/config', () => ({ ok: true, config }))
    addMethods('/dsh-pet-look/persona', {
      GET: () => ({ ok: true, persona: persona.get() }),
      POST: async (req) => ({ ok: true, persona: persona.set(await readBody(req)) }),
    })
    add('GET', '/dsh-pet-look/settings/state', () => settingsState())
    add('DELETE', '/dsh-pet-look/memory', () => ({ ok: true, memory: memory.clear() }))
    // 设置页与它的保存接口共用一条路径：GET 出 HTML，POST 存设置。
    // 一个 exact 路由只能挂一个 handler，分成两次注册后者会盖掉前者（0.2.0 就在这里出过 405）。
    try {
      disposers.push(ws.register({
        kind: 'exact',
        path: '/dsh-pet-look/settings',
        handler: async (req, res) => {
          if (!allow(req, req.method !== 'GET')) {
            res.statusCode = 403
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('forbidden')
            return
          }
          if (req.method === 'POST') {
            try {
              json(res, 200, { ok: true, applied: applySettings(await readBody(req)) })
            } catch (error) {
              json(res, 500, { ok: false, error: String(error && error.message) })
            }
            return
          }
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET, POST')
            res.statusCode = 405
            res.end()
            return
          }
          try {
            res.statusCode = 200
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end(renderPage(ws.getOrigin()))
          } catch {
            res.statusCode = 500
            res.end('settings page failed')
          }
        },
      }))
    } catch {}
    add('GET', '/dsh-pet-look/logs', () => {
      const day = localDay()
      const file = path.join(logger.logDir, `look-${day}.jsonl`)
      let lines = []
      try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-200) } catch {}
      return { ok: true, day, lines }
    })
    if (disposers.length > 0) logger.event({ ok: true, ms: 0, code: 'routes-ready' })
    return () => { for (const d of disposers) { try { d() } catch {} } }
  }

  let disposeRoutes = registerRoutes()

  logger.prune()
  sweepScratch()

  // 桌宠的 HTTP 服务、宿主的 llm 服务都是异步就绪的。启动顺序一变
  // （pet 还没 listen / llm 还没挂载）不能让菜单和视觉路由永久缺失，
  // 所以这里做有限度的自愈重试，而不是只试一次。
  const menuTimer = setInterval(() => {
    // 兜底自愈：即使 apply 早于 webServer 挂载运行，路由也会在下一拍补上。
    if (typeof disposeRoutes !== 'function') {
      const again = registerRoutes()
      if (typeof again === 'function') disposeRoutes = again
    }
    refreshMenu()
  }, 20000)
  let visionTimer = null

  async function probeVision() {
    const r = await vision.resolveRoute(true)
    state.visionRoute = r
    if (r.ok) {
      logger.event({ ok: true, ms: 0, code: 'vision-ready' })
      return true
    }
    // 启动早期 llm 尚未挂载属于正常时序，不记为故障。
    if (r.reason !== 'llm-unavailable') logger.event({ ok: false, ms: 0, code: `vision-${r.reason}` })
    return false
  }

  ctx.on('dispose', () => {
    disposed = true
    if (timer) clearTimeout(timer)
    clearTimeout(bootTimer)
    stopBubbleWatch()
    clearInterval(menuTimer)
    if (visionTimer) clearInterval(visionTimer)
    menu.stop()
    if (typeof disposeRoutes === 'function') disposeRoutes()
  })

  menu.start((label) => onMenuEvent(label))
  refreshMenu()
  probeVision().catch(() => {})
  visionTimer = setInterval(() => {
    if (disposed) { clearInterval(visionTimer); return }
    if (state.visionRoute && state.visionRoute.ok) { clearInterval(visionTimer); return }
    probeVision().then((ok) => { if (ok) clearInterval(visionTimer) }).catch(() => {})
  }, 60000)
  const bootTimer = setTimeout(() => schedule(12), 12000)
  logger.event({ ok: true, ms: 0, code: 'started' })

  return {
    status, manual, toggleAuto, state, config, persona,
    // 供离线测试驱动的内部句柄（不改变运行时行为）。
    _internals: { tick, canSpeak, canAnalyze, pickInterval, smartPauseReason, vision, memory, logger, menu, persona, isRepeat, overlap, say, applySettings, settingsState, openSettings },
  }
}

export default apply
