import fs from 'node:fs'
import path from 'node:path'
import { runPowerShell } from './util.js'
import { CAPTURE, PRIVACY, SYS, POWER, FOREGROUND } from './scripts.js'

function scratchDir() {
  const dir = path.join(process.env.TEMP || process.env.TMP || '.', 'dsh-pet-look')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

let seq = 0
export function scratchFile(ext) {
  seq = (seq + 1) % 100000
  return path.join(scratchDir(), `shot-${process.pid}-${Date.now()}-${seq}.${ext}`)
}

/** 清理本次运行遗留的临时图（进程被杀时可能残留）；只动自己命名空间下的文件。 */
export function sweepScratch(maxAgeMs = 6 * 3600 * 1000) {
  const dir = scratchDir()
  let removed = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('shot-')) continue
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        if (Date.now() - st.mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed += 1 }
      } catch {}
    }
  } catch {}
  return removed
}

export function dropFile(file) {
  if (!file) return
  try { fs.unlinkSync(file) } catch {}
}

/** 只截主显示器（Screen.PrimaryScreen.Bounds），缩放到 maxWidth 并返回 dHash。 */
export async function capturePrimaryScreen(maxWidth) {
  const out = scratchFile('jpg')
  const res = await runPowerShell(CAPTURE, {
    env: { DSH_LOOK_MAXW: String(Math.round(maxWidth)), DSH_LOOK_OUT: out },
    timeoutMs: 15000,
  })
  if (!res.ok || !res.data || res.data.ok !== true) {
    dropFile(out)
    return { ok: false, reason: res.data && res.data.reason ? String(res.data.reason) : res.reason || 'capture-failed' }
  }
  return { ok: true, path: out, width: res.data.width, height: res.data.height, srcW: res.data.srcW, srcH: res.data.srcH, hash: String(res.data.hash), monitors: res.data.monitors, ms: res.data.ms }
}

/**
 * 本地隐私闸门。失败关闭：OCR 不可用、脚本报错、判定为 blocked 都返回 ok:false 或 verdict:'blocked'。
 * 屏幕文字不回传（只回传命中码）。
 */
export async function privacyGate(imagePath, ratio, softBlockAt = 4) {
  const redacted = scratchFile('jpg')
  const res = await runPowerShell(PRIVACY, {
    env: {
      DSH_LOOK_IMG: imagePath,
      DSH_LOOK_REDACT: redacted,
      DSH_LOOK_RATIO: String(ratio),
      DSH_LOOK_SOFT: String(softBlockAt),
    },
    timeoutMs: 20000,
  })
  if (!res.ok || !res.data || res.data.ok !== true) {
    dropFile(redacted)
    return { ok: false, reason: (res.data && res.data.reason) || res.reason || 'privacy-failed' }
  }
  const verdict = String(res.data.verdict || 'blocked')
  const base = {
    codes: res.data.codes || [],
    keywords: res.data.keywords || [],
    lines: res.data.lines || 0,
    softHits: res.data.softHits || 0,
  }
  if (verdict === 'ok') {
    dropFile(redacted)
    return { ok: true, verdict: 'ok', path: imagePath, ...base }
  }
  if (verdict === 'redacted') {
    return { ok: true, verdict: 'redacted', path: redacted, ...base }
  }
  dropFile(redacted)
  return { ok: true, verdict: 'blocked', path: null, ...base }
}

/** 只取前台窗口标识（进程名 + 标题哈希），用于判断「用户是不是换了个窗口」。 */
export async function foregroundKey() {
  const res = await runPowerShell(FOREGROUND, { timeoutMs: 6000 })
  if (!res.ok || !res.data || res.data.ok !== true) return null
  return String(res.data.key || '')
}

export async function systemStatus() {
  const [sys, power] = await Promise.all([
    runPowerShell(SYS, { timeoutMs: 8000 }),
    runPowerShell(POWER, { timeoutMs: 8000 }),
  ])
  const s = sys.ok && sys.data && sys.data.ok ? sys.data : null
  const p = power.ok && power.data && power.data.ok ? power.data : null
  return {
    ok: Boolean(s),
    idleSec: s ? Number(s.idleSec) || 0 : 0,
    locked: s ? s.locked === true : false,
    proc: s ? String(s.proc || '') : '',
    titleLen: s ? Number(s.titleLen) || 0 : 0,
    tags: s && Array.isArray(s.tags) ? s.tags : [],
    onAC: p && p.onAC !== null && p.onAC !== undefined ? p.onAC === true : null,
    battery: p && p.battery !== null && p.battery !== undefined ? Number(p.battery) : null,
    load: p && p.load !== null && p.load !== undefined ? Number(p.load) : null,
    tempC: p && p.tempC !== null && p.tempC !== undefined ? Number(p.tempC) : null,
  }
}
