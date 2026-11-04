import fs from 'node:fs'
import path from 'node:path'

/**
 * 人设：把「怎么说话」从代码里拆出来，做成可切换、可自定义的配置。
 * 落在 dataDir/persona.json，跟着 Windows 用户走；换人用这台电脑只要换 preset。
 *
 * 设计边界：人设只决定语气、称呼、主动程度，绝不覆盖隐私门、频率上限、
 * 「不做生活管教」这些系统级规矩（见 rules()）。
 */

/** 任何预设都必须遵守的底线；address 由人设里的称呼替换。 */
export function rules(address = '主人') {
  const who = String(address || '主人').slice(0, 8)
  return `硬规矩（任何风格都不能违反）：
- 称呼对方「${who}」；每次只说 1—2 句中文，总长不超过 35 字。
- 只谈屏幕上看得见的具体内容：在学什么、代码卡在哪、在看什么视频或游戏。说不出具体内容就不开口。
- 不做生活管教：不劝睡、不催喝水/休息/运动、不评价作息与健康、不重复催促；对方主动问起才回答。
- 同一个话题不反复说；刚说过的话不换个说法再说一遍。
- 不卖萌、不客服腔，不说「检测到」「根据画面」这类暴露机制的话。`
}

/** 兼容 v0.1.2 的旧 key，避免升级后用户已选的人设被重置。 */
export const ALIASES = {
  friend: 'companion',
  focus: 'analyst',
  quiet: 'observer',
  coach: 'analyst',
}

/**
 * 五个预设。speakBias 只微调「够不够格开口」的置信度门槛，
 * 每小时上限与最小间隔仍由用户设置决定，预设不能突破。
 */
export const PRESETS = {
  companion: {
    label: '体贴陪伴型',
    text: '温和、自然的陪伴者：留意主人手上的任务和状态，遇到困难给一点帮助和鼓励，语气像熟人，不说教、不干涉。',
    speakBias: 0,
  },
  humor: {
    label: '幽默搞笑型',
    text: '轻松有趣：可以围绕屏幕内容开个小玩笑或吐槽，但不为搞笑而硬讲冷笑话，主人专注时不打断。',
    speakBias: 0.05,
  },
  analyst: {
    label: '理性分析型',
    text: '简洁、准确：指出画面里的问题、逻辑或下一步，偏知识讨论与分析，少用情绪化表达，不安慰、不铺垫。',
    speakBias: -0.05,
  },
  chatty: {
    label: '活泼健谈型',
    text: '更愿意开口：对屏幕里有意思的内容积极回应，可以顺着话题多说半句，但仍然遵守主人设的打扰频率。',
    speakBias: 0.12,
  },
  observer: {
    label: '安静观察型',
    text: '尽量不主动打扰：只有画面里出现明显值得说的内容（卡住、报错、明显进展）才开口；主人主动搭话时正常回应。',
    speakBias: -0.2,
  },
}

/** 菜单点一下按这个顺序轮换。 */
export const CYCLE = ['companion', 'humor', 'analyst', 'chatty', 'observer']

const MAX_TEXT = 300
const MAX_FORBID = 120

function clean(text, max) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function resolveKey(key) {
  const k = ALIASES[key] || key
  if (PRESETS[k]) return k
  if (k === 'custom') return 'custom'
  return 'companion'
}

export function createPersona(dataDir, config) {
  const file = path.join(dataDir, 'persona.json')
  const cfg = config?.persona || {}
  let current = {
    preset: resolveKey(cfg.preset || 'companion'),
    address: clean(cfg.address, 8) || '主人',
    custom: clean(cfg.custom, MAX_TEXT),
    forbid: clean(cfg.forbid, MAX_FORBID),
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw?.preset === 'string') current.preset = resolveKey(raw.preset)
    if (typeof raw?.address === 'string') current.address = clean(raw.address, 8) || '主人'
    if (typeof raw?.custom === 'string') current.custom = clean(raw.custom, MAX_TEXT)
    if (typeof raw?.forbid === 'string') current.forbid = clean(raw.forbid, MAX_FORBID)
  } catch {}

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({ ...current, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch {}
  }

  function presetInfo() {
    if (current.preset === 'custom') {
      return { label: current.custom ? '自定义' : '自定义（空）', text: current.custom || PRESETS.companion.text, speakBias: 0 }
    }
    return PRESETS[current.preset] || PRESETS.companion
  }

  function label() { return presetInfo().label }

  /** 交给模型的「人设」段落：预设/自定义描述 + 称呼 + 禁忌。 */
  function text() {
    const p = presetInfo()
    const parts = [p.text]
    if (current.address && current.address !== '主人') parts.push(`称呼对方「${current.address}」。`)
    if (current.forbid) parts.push(`不要涉及这些话题或说法：${current.forbid}。`)
    return parts.filter(Boolean).join(' ')
  }

  function get() {
    return {
      preset: current.preset,
      label: label(),
      text: text(),
      address: current.address,
      custom: current.custom,
      forbid: current.forbid,
      speakBias: presetInfo().speakBias || 0,
    }
  }

  /** 菜单里点一下：轮到下一个人设；自定义为空时跳过它。 */
  function cycle() {
    const order = current.custom ? [...CYCLE, 'custom'] : CYCLE
    const at = order.indexOf(current.preset)
    current.preset = order[(at + 1) % order.length] || 'companion'
    save()
    return get()
  }

  function set(patch) {
    if (patch && typeof patch.preset === 'string') current.preset = resolveKey(patch.preset)
    if (patch && typeof patch.address === 'string') current.address = clean(patch.address, 8) || '主人'
    if (patch && typeof patch.custom === 'string') {
      current.custom = clean(patch.custom, MAX_TEXT)
      if (current.custom && patch.preset === undefined && current.preset !== 'custom') current.preset = 'custom'
    }
    if (patch && typeof patch.forbid === 'string') current.forbid = clean(patch.forbid, MAX_FORBID)
    save()
    return get()
  }

  return { get, set, cycle, label, text, key: () => current.preset, file }
}
