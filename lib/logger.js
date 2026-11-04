import fs from 'node:fs'
import path from 'node:path'
import { localDay, readJson, writeJsonAtomic } from './util.js'

/**
 * 运行日志。只写：时间、成功/失败、耗时、状态码、错误原因。
 * 严禁写入：截图、屏幕文字、OCR 结果、聊天内容、任何凭据。
 */
export function createLogger(dir, keepDays) {
  const logDir = path.join(dir, 'logs')
  try { fs.mkdirSync(logDir, { recursive: true }) } catch {}
  const statsFile = path.join(dir, 'stats.json')
  // 漏斗计数：把「检查成功 / 视觉分析成功 / 发言成功 / 气泡成功」分开记。
  // 只累加数字，不含任何屏幕内容。
  const COUNTERS = ['analyses', 'quiet', 'held', 'repeat', 'noChange', 'privacySkips', 'autoSpeaks', 'manualSpeaks', 'truncated', 'sayFailed']
  const emptyStats = (day) => {
    const s = { day, total: 0, ok: 0, fail: 0, lastAt: 0, lastCode: '', speaks: 0, lastSpeakAt: 0, lastAutoSpeakAt: 0 }
    for (const k of COUNTERS) s[k] = 0
    return s
  }
  let stats = readJson(statsFile, null)
  const today = localDay()
  if (!stats || stats.day !== today) stats = emptyStats(today)
  for (const k of COUNTERS) if (typeof stats[k] !== 'number') stats[k] = 0
  if (typeof stats.lastSpeakAt !== 'number') stats.lastSpeakAt = 0
  if (typeof stats.lastAutoSpeakAt !== 'number') stats.lastAutoSpeakAt = 0
  stats.day = today

  function fileFor(day) { return path.join(logDir, `look-${day}.jsonl`) }

  function prune() {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000
    let removed = 0
    try {
      for (const name of fs.readdirSync(logDir)) {
        if (!/^look-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
        const day = name.slice(5, 15)
        const t = new Date(`${day}T00:00:00`).getTime()
        if (Number.isFinite(t) && t < cutoff) {
          try { fs.unlinkSync(path.join(logDir, name)); removed += 1 } catch {}
        }
      }
    } catch {}
    return removed
  }

  function rollDay() {
    const d = localDay()
    if (stats.day !== d) {
      stats = emptyStats(d)
      prune()
    }
  }

  /** 只累加诊断计数（不写日志行，不接触任何屏幕内容）。 */
  function count(name, n = 1) {
    if (!COUNTERS.includes(name)) return
    rollDay()
    stats[name] += n
    writeJsonAtomic(statsFile, stats)
  }

  function event({ ok, ms = 0, code = '' }) {
    rollDay()
    stats.total += 1
    if (ok) stats.ok += 1
    else stats.fail += 1
    stats.lastAt = Date.now()
    stats.lastCode = String(code).slice(0, 40)
    writeJsonAtomic(statsFile, stats)
    try {
      fs.appendFileSync(fileFor(stats.day), `${JSON.stringify({ t: new Date().toISOString(), ok: Boolean(ok), ms: Math.round(ms), code: stats.lastCode })}\n`)
    } catch {}
  }

  function spoke(kind = 'auto') {
    rollDay()
    stats.speaks += 1
    stats.lastSpeakAt = Date.now()
    if (kind === 'auto') stats.lastAutoSpeakAt = stats.lastSpeakAt
    stats[kind === 'manual' ? 'manualSpeaks' : 'autoSpeaks'] += 1
    writeJsonAtomic(statsFile, stats)
  }

  function snapshot() { rollDay(); return { ...stats } }

  return { event, spoke, count, snapshot, prune, logDir }
}
