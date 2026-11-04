import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const PS_PREFIX = "$ErrorActionPreference='Stop';\n[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n$ProgressPreference='SilentlyContinue';\n"

/** 运行一段内联 PowerShell（不落 .ps1 文件：AMSI 会拦截落盘的组合脚本）。 */
export function runPowerShell(script, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', PS_PREFIX + script],
        { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-failed', error: String(error && error.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      resolve({ ok: false, reason: 'timeout' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, reason: 'spawn-failed', error: String(error && error.message) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let parsed = null
      const text = stdout.trim()
      if (text) {
        try { parsed = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) } catch { parsed = null }
      }
      resolve({ ok: code === 0 && parsed !== null, code, stdout: text, stderr, data: parsed })
    })
  })
}

export function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1
  return d
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

export function isoNow() {
  return new Date().toISOString()
}

export function localDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

export function joinPath(...parts) {
  return path.join(...parts)
}
