import path from 'node:path'
import { readJson, writeJsonAtomic } from './util.js'

/**
 * 长期记忆：插件自有的有界 JSON 存储。
 * 宿主没有公开的长期记忆写入服务；桌宠自己的 memory.json 只存对话轮次、
 * 且只能通过 POST /chat 追加（会额外生成一句回复）。这里只保留"智能筛选"后的
 * 任务/兴趣/进度三类事实，并在每次识屏时注入提示词。
 */
export function createMemory(dir, config) {
  const file = path.join(dir, 'memory.json')
  let db = readJson(file, null)
  if (!db || typeof db !== 'object' || !Array.isArray(db.items)) db = { version: 1, items: [] }

  function save() { writeJsonAtomic(file, db) }

  function prune() {
    const max = config.memory.maxEntries
    if (db.items.length <= max) return
    const active = db.items.filter((i) => i.status === 'active')
    const rest = db.items.filter((i) => i.status !== 'active')
    rest.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    const keep = active.slice(-max)
    const room = Math.max(0, max - keep.length)
    db.items = [...rest.slice(-room), ...keep]
  }

  function activeList(limit = config.memory.injectEntries) {
    if (limit <= 0) return []
    return db.items
      .filter((i) => i.status === 'active')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
  }

  /**
   * 敏感信息闸门：即使模型判断"有长期价值"，带凭证/身份/支付特征的文本一律拒绝入库。
   * 宁可少记，也不把隐私写进磁盘。
   */
  function unsafe(text) {
    if (/\d{6,}/.test(text)) return true
    if (/(密码|口令|验证码|支付|付款|转账|网银|银行卡|信用卡|借记卡|身份证|护照|手机号|手机号码|邮箱|账号|帐号|余额|账单|私钥|助记词|api[\s_-]?key|token|密钥)/i.test(text)) return true
    return false
  }

  function apply(entry) {
    if (!entry || typeof entry.text !== 'string') return null
    const text = entry.text.trim().slice(0, 160)
    if (text.length < 4) return null
    if (unsafe(text)) return null
    const key = (entry.key || '').trim().slice(0, 40) || Buffer.from(text).toString('base64').slice(0, 16)
    const now = Date.now()
    const found = db.items.find((i) => i.key === key)
    if (found) {
      found.text = text
      found.status = entry.status === 'done' ? 'done' : 'active'
      found.updatedAt = now
      found.hits = (found.hits || 1) + 1
    } else {
      db.items.push({ key, text, status: entry.status === 'done' ? 'done' : 'active', createdAt: now, updatedAt: now, hits: 1 })
    }
    prune()
    save()
    return key
  }

  function snapshot() {
    return { total: db.items.length, active: db.items.filter((i) => i.status === 'active').length }
  }

  /** 给设置页看的明细（最多 50 条，按更新时间倒序）。 */
  function list(limit = 50) {
    return db.items
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
      .map((i) => ({ key: i.key, text: i.text, status: i.status, updatedAt: i.updatedAt }))
  }

  /** 用户点「清空记忆」：整库清掉，不是只清 active。 */
  function clear() {
    db = { version: 1, items: [] }
    save()
    return snapshot()
  }

  return { activeList, apply, snapshot, list, clear, file }
}
