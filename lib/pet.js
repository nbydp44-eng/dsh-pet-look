import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms) } catch { return undefined }
}

export function createPet(ctx, config) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const memoryFile = path.join(dshHome, 'dsh-pet', 'memory.json')

  function base() {
    const ws = ctx.get('webServer')
    let origin = 'http://127.0.0.1:4254'
    try {
      if (ws && typeof ws.getOrigin === 'function') origin = ws.getOrigin()
    } catch {}
    return `${origin}/dsh-pet-7340`
  }

  /** 气泡：写 pets.<id>.say；不打开聊天窗口。 */
  async function broadcast(text, duration = 12000) {
    if (!text) return false
    const qs = new URLSearchParams({ pet: config.petId, surface: config.surface })
    try {
      const res = await fetch(`${base()}/broadcast?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 200), duration }),
        signal: timeoutSignal(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async function state() {
    try {
      const res = await fetch(`${base()}/state`, { signal: timeoutSignal(4000) })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  /** 桌宠是否正与用户对话：它的对话记忆刚被写过（POST /chat 落盘）。 */
  function chatting() {
    try {
      const st = fs.statSync(memoryFile)
      return Date.now() - st.mtimeMs < config.chatWindowSec * 1000
    } catch {
      return false
    }
  }

  async function agentBusy() {
    const s = await state()
    const ws = s && s.sections && s.sections.workStatus
    return Boolean(ws && ws.state === 'working')
  }

  return { broadcast, state, chatting, agentBusy, base, memoryFile }
}
