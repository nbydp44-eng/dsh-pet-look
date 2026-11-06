import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms) } catch { return undefined }
}

export function createPet(ctx, config) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const memoryFile = path.join(dshHome, 'dsh-pet', 'memory.json')
  /** 上一次由我们写进去的那条 assistant 的 ts，用来识别「连续独白」。 */
  let lastOwnTs = 0

  function base() {
    const ws = ctx.get('webServer')
    let origin = 'http://127.0.0.1:4254'
    try {
      if (ws && typeof ws.getOrigin === 'function') origin = ws.getOrigin()
    } catch {}
    return `${origin}/dsh-pet-7340`
  }

  /** 气泡：写 pets.<id>.say；不打开聊天窗口。duration 是毫秒，0 表示不显示。 */
  async function broadcast(text, duration = config.bubble.durationMs) {
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

  /** 智能收起：只清气泡，不触发任何模型调用。 */
  async function clearBubble() {
    const qs = new URLSearchParams({ pet: config.petId, surface: config.surface })
    try {
      const res = await fetch(`${base()}/bubble/clear?${qs}`, { method: 'POST', signal: timeoutSignal(4000) })
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

  /**
   * 把刚说出口的这句写进桌宠自己的对话记忆。
   * 用户点开对话时，历史里就有这句，接着聊不会「不知道刚才说过什么」。
   * 零模型调用；只在没人聊天、文件没刚被写过时才动，写完留一份 .bak。
   */
  async function noteAssistant(text) {
    const clean = String(text || '').trim()
    if (!clean) return false
    try {
      const st = fs.statSync(memoryFile)
      // 桌宠自己刚读写过记忆（正在聊天）：不要抢写，直接放弃。
      if (Date.now() - st.mtimeMs < 8000) return false
      const mem = JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
      if (!mem || typeof mem !== 'object' || Array.isArray(mem)) return false
      const entryKey = String(config.petEntry || 'main')
      const bucket = mem[entryKey] && typeof mem[entryKey] === 'object' && !Array.isArray(mem[entryKey])
        ? mem[entryKey]
        : (mem[entryKey] = {})
      const slot = bucket[config.petId] && Array.isArray(bucket[config.petId].messages)
        ? bucket[config.petId]
        : (bucket[config.petId] = { messages: [] })
      const last = slot.messages[slot.messages.length - 1]
      if (last && last.role === 'assistant' && String(last.content || '').trim() === clean) return false
      // 连续几条都是我们写的（用户还没开口）：只留最新的一条，别把历史堆成独白。
      if (last && last.role === 'assistant' && last.ts === lastOwnTs) {
        last.content = clean
        last.ts = Date.now()
      } else {
        const ts = Date.now()
        slot.messages.push({ role: 'assistant', content: clean, ts })
        lastOwnTs = ts
      }
      if (slot.messages.length > 400) slot.messages.splice(0, slot.messages.length - 400)
      const tmp = `${memoryFile}.look-tmp`
      fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8')
      try { fs.copyFileSync(memoryFile, `${memoryFile}.bak`) } catch {}
      fs.renameSync(tmp, memoryFile)
      return true
    } catch {
      return false
    }
  }

  async function agentBusy() {
    const s = await state()
    const ws = s && s.sections && s.sections.workStatus
    return Boolean(ws && ws.state === 'working')
  }

  return { broadcast, clearBubble, state, chatting, agentBusy, base, memoryFile, noteAssistant }
}
