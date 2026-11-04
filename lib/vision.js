import fs from 'node:fs'

/** 匿名/免费聚合渠道：未经用户明确指定，绝不把截图交给它们。 */
const UNTRUSTED = /(free|anonymous|ovh|kilo|g4f|pollinations|chatanywhere|gpt4free|duckduckgo)/i

import { rules } from './persona.js'

/**
 * 系统提示词 = 固定职责 + 用户选定的人设 + 输出契约。
 * 人设只改「怎么说话」，不改「看什么、什么时候闭嘴」。
 */
function buildSystem(personaText, address = '主人') {
  const who = String(address || '主人').slice(0, 8)
  return `你是桌宠「大肥鱼」，${who}此刻在 Windows 电脑前。你能看到${who}主显示器的当前画面（敏感信息已在本地遮挡）。

【人设】${personaText || '像一个熟了多年的朋友：随口点评屏幕上的东西，语气轻松。'}
${rules(address)}

判断：先理解${who}在做什么，再决定要不要说话。
- 画面里有具体可聊的内容（在学什么、代码在做什么、哪里报错、视频讲什么、游戏进行到哪），就说一句。
- 同一内容不重复说；只是滚动、等待、空白、看不出在做什么时保持安静。
- 聊天、支付、隐私场景保持安静。
只输出 JSON（不要代码块、不要解释）：
{"scene":"study|code|game|video|chat|payment|other","speak":true,"text":"要对${who}说的话","stuck":false,"confidence":0.7,"memory":null}
规则：
- text 必须落在画面里的具体东西上（哪门课、哪段代码、哪类视频），不要泛泛而谈。
- text 最多两句，能一口气说完；写不出具体内容就别 speak。
- memory 只在有长期价值时给出：{"key":"短标识","text":"一句话事实","status":"active|done"}；普通画面细节不要记；不确定就 null。
- stuck=true 仅当画面明确显示卡住、反复报错或长时间停滞。
- 不要提及「截图」「识屏」「图片」，不要复述屏幕上的隐私内容。`
}

/** 气泡只有一两行宽度：把模型话术裁成短句，顺带清掉 JSON 残片与控制字符。 */
function cleanText(value, maxChars) {
  let t = String(value || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^[{[`]/.test(t)) {
    const m = t.match(/"text"\s*:\s*"([^"]*)"/)
    if (m) t = m[1]
  }
  t = t.replace(/^["'`{[\]}\s]+/, '').replace(/["'`{[\]}\s]+$/, '').trim()
  if (maxChars > 0 && t.length > maxChars) {
    // 气泡每行约 16 个汉字，超长会顶出桌面；优先在句号处断，退而求其次加省略号。
    t = t.slice(0, maxChars)
    const cut = Math.max(t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('？'))
    if (cut >= Math.floor(maxChars / 2)) t = t.slice(0, cut + 1)
    else t = t.replace(/[，、,；;：:\s]$/, '') + '…'
  }
  return t
}

function parseReply(raw, manual, maxChars) {
  const text = String(raw || '').replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const body = text.slice(start, end + 1)
    const attempts = [
      body,
      // 模型偶尔在字符串里直接换行，或留下尾逗号：这两种是唯一值得修的破坏。
      body.replace(/\r?\n/g, ' ').replace(/,\s*([}\]])/g, '$1'),
    ]
    for (const candidate of attempts) {
      try {
        const obj = JSON.parse(candidate)
        const speak = manual ? true : obj.speak === true
        const talk = cleanText(obj.text, maxChars)
        if (!talk) break
        return {
          ok: true,
          scene: typeof obj.scene === 'string' ? obj.scene : 'other',
          speak,
          text: talk,
          stuck: obj.stuck === true,
          confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : 0.5,
          memory: obj.memory && typeof obj.memory === 'object' && typeof obj.memory.text === 'string'
            ? { key: String(obj.memory.key || ''), text: String(obj.memory.text), status: obj.memory.status === 'done' ? 'done' : 'active' }
            : null,
        }
      } catch {}
    }
  }
  // 兜底：模型没按 JSON 说话时，也绝不把整段 JSON 塞进气泡。
  const talk = cleanText(text, maxChars)
  if (!talk) return { ok: false, reason: 'empty-reply' }
  return { ok: true, scene: 'other', speak: manual, text: talk, stuck: false, confidence: 0.4, memory: null }
}

/**
 * 视觉分析。
 * 生命周期：截图字节 → 附件服务（临时） → 模型调用 → **立刻删除附件对象**，只保留文本结论。
 */
export function createVision(ctx, config, log) {
  let route = null
  let checkedAt = 0

  async function resolveRoute(force = false) {
    const llm = ctx.get('llm')
    if (!llm) return { ok: false, reason: 'llm-unavailable' }
    if (!force && route && Date.now() - checkedAt < 10 * 60 * 1000) return route
    if (config.vision.provider && config.vision.model) {
      try {
        const info = await llm.resolveModelInfo(config.vision.provider, config.vision.model)
        if (!Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
          route = { ok: false, reason: 'configured-model-no-image' }
          checkedAt = Date.now()
          return route
        }
      } catch {
        route = { ok: false, reason: 'configured-model-unavailable' }
        checkedAt = Date.now()
        return route
      }
      route = { ok: true, provider: config.vision.provider, model: config.vision.model }
      checkedAt = Date.now()
      return route
    }
    let providers = []
    try { providers = llm.listProviders() } catch { providers = [] }
    for (const p of providers) {
      if (!p || !p.id || UNTRUSTED.test(p.id)) continue
      let models = []
      try { models = await llm.listModels(p.id) } catch { continue }
      for (const m of models) {
        let modalities = Array.isArray(m.inputModalities) ? m.inputModalities : null
        if (!modalities) {
          try { modalities = (await llm.resolveModelInfo(p.id, m.id)).inputModalities || null } catch { modalities = null }
        }
        if (Array.isArray(modalities) && modalities.includes('image')) {
          route = { ok: true, provider: p.id, model: m.id }
          checkedAt = Date.now()
          return route
        }
      }
    }
    route = { ok: false, reason: 'no-vision-route' }
    checkedAt = Date.now()
    return route
  }

  async function analyze({ imagePath, mediaType = 'image/jpeg', sceneHint, tags = [], proc = '', memories = [], recent = [], manual = false, persona = '', address = '主人', silenceMin = 0, signal }) {
    const attachments = ctx.get('attachments')
    if (!attachments) return { ok: false, reason: 'attachments-unavailable' }
    const r = await resolveRoute()
    if (!r.ok) return r
    const bytes = fs.readFileSync(imagePath)
    let ref = null
    try {
      ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: 'look.jpg' })
    } catch (error) {
      return { ok: false, reason: 'attach-failed' }
    }
    try {
      const memoryBlock = memories.length
        ? memories.map((m) => `- ${m.text}`).join('\n')
        : '（暂无）'
      const hint = [
        `前台应用：${proc || '未知'}${tags.length ? `（类别：${tags.join('/')}）` : ''}`,
        `场景参考：${sceneHint || 'other'}`,
        `时间：${new Date().toTimeString().slice(0, 5)}`,
        `长期记忆：\n${memoryBlock}`,
        recent.length ? `最近已经说过（不要重复或换汤不换药）：\n${recent.map((s) => `- ${s}`).join('\n')}` : '',
        !manual && silenceMin >= 45
          ? '自动识屏：已经很久没开口了；画面里只要有具体内容，就说一句具体的观察或建议（speak=true）。'
          : '自动识屏：画面里有具体可聊的内容就 speak=true 说一句；确实没什么值得说再 false。',
      ].join('\n')
      const chunks = ctx.get('llm').stream({
        provider: r.provider,
        model: r.model,
        temperature: config.vision.temperature,
        maxTokens: config.vision.maxTokens,
        signal,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: hint },
            { type: 'image', attachment: ref },
          ],
        }],
        system: buildSystem(persona, address),
      })
      let out = ''
      let failure = null
      let finishKind = ''
      for await (const chunk of chunks) {
        if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') out += chunk.block.text
        else if (chunk.type === 'text-delta') out += chunk.text
        else if (chunk.type === 'finish') {
          finishKind = String((chunk.reason && chunk.reason.kind) || '')
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = chunk.reason.failure || { code: chunk.reason.kind, message: '' }
          }
        }
      }
      if (failure) return { ok: false, reason: 'model-error', code: String(failure.code || ''), detail: String(failure.message || '').slice(0, 200) }
      // 推理型模型会把输出预算先花在思考上：max-tokens 且没有正文 = 白花一次调用，
      // 单独记成 truncated，便于诊断时和真正的空回复区分开。
      if (!out.trim() && finishKind === 'max-tokens') return { ok: false, reason: 'truncated' }
      const parsed = parseReply(out, manual, config.speak.maxChars)
      if (!parsed.ok) return parsed
      return { ...parsed, provider: r.provider, model: r.model }
    } catch (error) {
      return { ok: false, reason: 'model-call-failed', detail: String((error && error.message) || error).slice(0, 200) }
    } finally {
      // 截图对象用完即删：数据生命周期止于本次分析。
      try {
        const host = attachments.imageHostPath(ref)
        if (host) fs.unlinkSync(host)
      } catch {}
    }
  }

  return { analyze, resolveRoute, invalidate() { route = null; checkedAt = 0 } }
}

export const __test = { parseReply, cleanText, buildSystem }

