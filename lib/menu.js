import { sleep } from './util.js'

const OWNER = 'dsh-pet-look'

/**
 * 右键菜单：走 dsh-pet 的第三方菜单 API（POST /menu/item + GET /menu/events 长轮询）。
 * 标签整体覆盖式注册；事件按标签前缀归类，避免状态变化后点旧标签失效。
 */
export function createMenu(pet, log) {
  let last = ''
  let announced = false
  let stopped = false
  let loop = null

  /**
   * 状态类菜单项把间隔/最近时间/今日计数直接写在标签里：宿主只提供“标签列表 + 点击事件”，
   * 没有单独的可读文本行，这样状态不用点开气泡也能看到。
   */
  function currentLabels(autoOn, info = {}) {
    const interval = info.intervalSec || 0
    const last = info.lastTime || '—'
    const total = info.total || 0
    const ok = info.ok || 0
    const fail = info.fail || 0
    return [
      autoOn ? '自动识屏：开' : '自动识屏：暂停',
      '立即识屏',
      `人设：${info.persona || '体贴陪伴型'}`,
      '设置面板',
      `状态：${interval}秒 · ${last}`,
      `今日：${total} 次（成 ${ok} / 败 ${fail}）`,
    ]
  }

  async function register(labels) {
    const key = labels.join('|')
    if (key === last) return true
    try {
      const res = await fetch(`${pet.base()}/menu/item`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: OWNER, labels, target: 'desktop' }),
      })
      if (res.ok) {
        last = key
        if (!announced) {
          announced = true
          log.event({ ok: true, ms: 0, code: 'menu-ready' })
        }
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async function poll(onEvent) {
    while (!stopped) {
      let events = null
      try {
        const res = await fetch(`${pet.base()}/menu/events?owner=${OWNER}&wait=8000`, { signal: AbortSignal.timeout(12000) })
        if (res.ok) events = (await res.json()).events || null
      } catch {}
      if (stopped) return
      if (!events) { await sleep(1500); continue }
      for (const label of Object.keys(events)) {
        // 宿主把本轮所有标签都列出来，只有真正被点的那个是宠物 id，其余为 null。
        if (events[label] === null) continue
        try { await onEvent(label) } catch {}
      }
    }
  }

  function start(onEvent) {
    if (!loop) loop = poll(onEvent)
  }

  function stop() {
    stopped = true
    loop = null
  }

  return { register, currentLabels, start, stop }
}
