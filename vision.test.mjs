// 视觉调用的重试与失败分类：一次「没说完」不应该被判成「服务不可用」。
// 全程用假 llm，不读屏幕、不上传任何东西。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createVision } from './lib/vision.js'
import { normalizeConfig } from './lib/config.js'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// 一个最小的合法 PNG（1x1 透明），只用于走 saveImage 的字节路径。
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const tmp = path.join(os.tmpdir(), 'look-vision-test')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const imagePath = path.join(tmp, 'shot.png')
fs.writeFileSync(imagePath, png)

/** 按顺序返回预设的流：每项是一组 chunk。 */
function makeCtx(scripts) {
  let call = 0
  const seen = []
  const hostFile = path.join(tmp, 'host.png')
  fs.writeFileSync(hostFile, 'x')
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: () => [{ id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    stream(options) {
      seen.push(options)
      const chunks = scripts[Math.min(call, scripts.length - 1)]
      call += 1
      return (async function* () {
        for (const c of chunks) yield c
      })()
    },
  }
  const attachments = {
    saveImage: async () => ({ attachmentId: 'a1', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }),
    imageHostPath: () => hostFile,
  }
  const ctx = { get: (name) => (name === 'llm' ? llm : name === 'attachments' ? attachments : undefined) }
  return { ctx, seen, calls: () => call }
}

const cfg = normalizeConfig({})
const empty = [{ type: 'finish', reason: { kind: 'max-tokens' } }]
const good = [
  { type: 'block-end', block: { type: 'text', text: '{"scene":"study","speak":true,"text":"这页在讲矩阵的秩。","stuck":false,"confidence":0.7,"memory":null}' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

{
  // 第一次只有推理、没有正文；第二次在更大预算下说出了话。
  const { ctx, seen, calls } = makeCtx([empty, good])
  const vision = createVision(ctx, cfg, () => {})
  const res = await vision.analyze({ imagePath, mediaType: 'image/png', persona: '', address: '主人', memories: [], recent: [], manual: false })
  check('retry-recovers', res.ok && res.text === '这页在讲矩阵的秩。' && res.retried === true, `ok=${res.ok} retried=${res.retried}`)
  check('retry-doubles-budget', calls() === 2 && seen[1].maxTokens > seen[0].maxTokens, `calls=${calls()} ${seen[0]?.maxTokens}->${seen[1]?.maxTokens}`)
}

{
  // 两次都空：记为 truncated，并且明确 retried，便于和真正的服务故障区分。
  const { ctx, calls } = makeCtx([empty])
  const vision = createVision(ctx, cfg, () => {})
  const res = await vision.analyze({ imagePath, mediaType: 'image/png', persona: '', address: '主人', memories: [], recent: [], manual: false })
  check('both-empty-truncated', !res.ok && res.reason === 'truncated' && res.retried === true, `reason=${res.reason} retried=${res.retried}`)
  check('both-empty-two-calls', calls() === 2, `calls=${calls()}`)
}

{
  // 模型报错不属于「没说完」，不重试，也别浪费第二次调用。
  const bad = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limit', message: 'slow down' } } }]
  const { ctx, calls } = makeCtx([bad, good])
  const vision = createVision(ctx, cfg, () => {})
  const res = await vision.analyze({ imagePath, mediaType: 'image/png', persona: '', address: '主人', memories: [], recent: [], manual: false })
  check('model-error-not-retried', !res.ok && res.reason === 'model-error' && calls() === 1, `reason=${res.reason} calls=${calls()}`)
}

{
  // 没有附件服务时直接失败，不去调用模型。
  const { ctx } = makeCtx([good])
  const vision = createVision({ get: (n) => (n === 'llm' ? ctx.get('llm') : undefined) }, cfg, () => {})
  const res = await vision.analyze({ imagePath, mediaType: 'image/png', persona: '', address: '主人', memories: [], recent: [], manual: false })
  check('attachments-required', !res.ok && res.reason === 'attachments-unavailable', `reason=${res.reason}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
