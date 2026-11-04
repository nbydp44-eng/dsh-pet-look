/** 配置默认值与归一化。插件配置来自 cordis 补丁行的 config，缺省即用 DEFAULTS。 */

export const DEFAULTS = {
  petId: 'main',
  surface: 'desktop',
  enabled: true,
  /** 秒。normal=普通场景；dynamic=视频/游戏；battery=电池供电；slow=负载偏高时。 */
  intervals: { normal: 60, dynamic: 120, battery: 180, slow: 150 },
  /** 用户多久没操作就暂停自动识屏（秒）。 */
  idlePauseSec: 180,
  /** 锁屏/息屏时轮询恢复的间隔（秒）。 */
  pausedPollSec: 30,
  load: { slowAbove: 55, pauseAbove: 85 },
  temp: { slowAbove: 80, pauseAbove: 92 },
  /** 变化检测：汉明距离阈值（64 位 dHash）。 */
  change: { significant: 8, minor: 4, minorMinGapSec: 240 },
  /** 主动发言频率；maxChars 是气泡可容纳的字数，超过会被截断。 */
  speak: { maxPerHour: 3, minGapSec: 900, minConfidence: 0.45, maxChars: 42, nightQuiet: { enabled: false, from: 23, to: 7 } },
  /** 人设：preset 见 lib/persona.js（companion/humor/analyst/chatty/observer/custom）；custom 非空时生效。 */
  persona: { preset: 'companion', address: '主人', custom: '', forbid: '' },
  /** maxPerHour 是「模型调用」上限，不是发言上限：它只防止同一画面反复问模型。 */
  vision: { provider: '', model: '', maxWidth: 1600, temperature: 0.6, maxTokens: 800, timeoutMs: 45000, maxPerHour: 24 },
  /** 气泡：默认长留（10 分钟），窗口切换后智能收起（收起不发模型请求）。 */
  bubble: { durationMs: 600000, clearOnSwitch: true },
  /** 本地隐私检测；关闭即等于停用云端分析（失败关闭）。 */
  privacy: { enabled: true, maxMatchedLineRatio: 0.35, softBlockAt: 4 },
  memory: { enabled: true, maxEntries: 120, injectEntries: 10 },
  logs: { keepDays: 7 },
  /** 手动识屏后自动识屏暂缓的秒数。 */
  manualCooldownSec: 600,
  /** 与上次分析画面几乎相同则直接复用结论、不再上传。 */
  dedupe: { hashDistance: 5, windowSec: 600 },
  /** 本机宠物聊天判定窗口：memory.json 在这么多秒内被写过即视为聊天中。 */
  chatWindowSec: 120,
  /** 允许在自动识屏暂停时仍执行手动识屏。 */
  allowManualWhilePaused: true,
  /** 测试/诊断用本地 HTTP 路由。 */
  debugRoutes: true,
  dataDir: '',
}

function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function pick(base, patch) {
  const out = { ...base }
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) continue
      const b = base[k]
      if (b && typeof b === 'object' && !Array.isArray(b) && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = pick(b, v)
      } else {
        out[k] = v
      }
    }
  }
  return out
}

export function normalizeConfig(raw) {
  const c = pick(DEFAULTS, raw)
  c.intervals.normal = num(c.intervals.normal, 60, 30, 3600)
  c.intervals.dynamic = num(c.intervals.dynamic, 120, 30, 3600)
  c.intervals.battery = num(c.intervals.battery, 180, 30, 3600)
  c.intervals.slow = num(c.intervals.slow, 150, 30, 3600)
  c.idlePauseSec = num(c.idlePauseSec, 180, 30, 36000)
  c.pausedPollSec = num(c.pausedPollSec, 30, 10, 300)
  c.load.slowAbove = num(c.load.slowAbove, 55, 10, 100)
  c.load.pauseAbove = num(c.load.pauseAbove, 85, 20, 100)
  c.temp.slowAbove = num(c.temp.slowAbove, 80, 40, 110)
  c.temp.pauseAbove = num(c.temp.pauseAbove, 92, 50, 120)
  c.change.significant = num(c.change.significant, 8, 1, 40)
  c.change.minor = num(c.change.minor, 4, 0, 40)
  c.change.minorMinGapSec = num(c.change.minorMinGapSec, 240, 60, 3600)
  c.speak.maxPerHour = num(c.speak.maxPerHour, 3, 1, 20)
  c.speak.minGapSec = num(c.speak.minGapSec, 900, 60, 86400)
  c.speak.minConfidence = num(c.speak.minConfidence, 0.45, 0, 1)
  c.speak.maxChars = num(c.speak.maxChars, 42, 12, 200)
  c.speak.nightQuiet.from = num(c.speak.nightQuiet.from, 23, 0, 23)
  c.speak.nightQuiet.to = num(c.speak.nightQuiet.to, 7, 0, 23)
  c.vision.maxWidth = num(c.vision.maxWidth, 1600, 640, 3840)
  c.vision.temperature = num(c.vision.temperature, 0.6, 0, 2)
  c.vision.maxTokens = num(c.vision.maxTokens, 800, 128, 3000)
  c.vision.maxPerHour = num(c.vision.maxPerHour, 24, 4, 120)
  c.vision.timeoutMs = num(c.vision.timeoutMs, 45000, 5000, 120000)
  c.bubble.durationMs = num(c.bubble.durationMs, 600000, 5000, 3600000)
  c.persona.custom = String(c.persona.custom || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300)
  c.persona.forbid = String(c.persona.forbid || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120)
  c.persona.address = String(c.persona.address || '主人').slice(0, 8)
  c.privacy.maxMatchedLineRatio = num(c.privacy.maxMatchedLineRatio, 0.35, 0.05, 1)
  c.privacy.softBlockAt = num(c.privacy.softBlockAt, 4, 2, 12)
  c.memory.maxEntries = num(c.memory.maxEntries, 120, 10, 1000)
  c.memory.injectEntries = num(c.memory.injectEntries, 10, 0, 50)
  c.logs.keepDays = num(c.logs.keepDays, 7, 1, 90)
  c.manualCooldownSec = num(c.manualCooldownSec, 600, 0, 7200)
  c.dedupe.hashDistance = num(c.dedupe.hashDistance, 5, 0, 40)
  c.dedupe.windowSec = num(c.dedupe.windowSec, 600, 30, 7200)
  c.chatWindowSec = num(c.chatWindowSec, 120, 30, 600)
  return c
}
