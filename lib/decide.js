/**
 * 自动发言的判定规则（纯函数，便于测试与解释）。
 *
 * 背景：模型偶尔会「写了话，却把 speak 标成 false」，也偶尔在没内容时返回空 text。
 * 因此同时把「显式开口」和「已经写出具体句子」当作开口意图；后者用一个较低的置信度地板，
 * 避免因为保守评分把一句完整的话丢掉。真正没话可说时，模型给的是空 text。
 */
export const TEXT_FLOOR = 0.35
export const OTHER_SELF_FLOOR = 0.6
export const OTHER_TEXT_FLOOR = 0.35

export function evaluate(res, { threshold = 0.45, silent = false, minText = 4 } = {}) {
  const text = String((res && res.text) || '').trim()
  const confidence = Number(res && res.confidence)
  const scene = (res && res.scene) || 'other'
  const selfSaid = res && res.speak === true

  const hasText = text.length >= minText
  const wantsSpeak = selfSaid || hasText
  // 已经写出句子时给一点宽容，但人设门槛越高、这份宽容也越小，不会被用来绕过「安静观察型」。
  const floor = selfSaid ? threshold : Math.min(threshold, Math.max(TEXT_FLOOR, threshold - 0.1))
  const confident = Number.isFinite(confidence) && confidence >= floor
  // 编程场景只在明确卡住时开口，避免把正常写码当异常。
  const codeOk = scene !== 'code' || (res && res.stuck === true)
  // 看不出场景时，模型显式说「值得说」要求更高置信度。
  const otherOk = scene !== 'other' || (Number.isFinite(confidence) && confidence >= (selfSaid ? OTHER_SELF_FLOOR : OTHER_TEXT_FLOOR))
  const ok = wantsSpeak && hasText && !silent && confident && codeOk && otherOk

  return { hasText, wantsSpeak, floor, confident, codeOk, otherOk, ok }
}
