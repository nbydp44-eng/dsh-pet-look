// 人设系统的离线测试：预设轮换、旧 key 兼容、自定义、称呼/禁忌、长度与字符清洗。
// 不依赖 DSH，也不读写真实配置目录（用临时目录）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPersona, PRESETS, CYCLE, ALIASES, rules } from './lib/persona.js'

const dir = path.join(os.tmpdir(), 'look-persona-test')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const p = createPersona(dir, { persona: {} })
check('default-companion', p.get().preset === 'companion' && p.label() === PRESETS.companion.label)

const order = []
for (let i = 0; i < 5; i += 1) order.push(p.cycle().preset)
check('cycle-order', order.join(',') === 'humor,analyst,chatty,observer,companion', order.join(','))
check('cycle-labels', CYCLE.every((k) => PRESETS[k] && PRESETS[k].text.length > 10))

p.set({ preset: 'friend' })
check('alias-legacy-friend', p.get().preset === 'companion' && ALIASES.friend === 'companion')
p.set({ preset: 'focus' })
check('alias-legacy-focus', p.get().preset === 'analyst')

p.set({ preset: 'custom', custom: '  像实验室师兄，说话直接，会追问思路  ' })
check('custom-trimmed', p.get().custom === '像实验室师兄，说话直接，会追问思路')
check('custom-label', p.label() === '自定义')

// 落盘后新实例能读回来（换人用这台电脑、或 DSH 重启）
const p2 = createPersona(dir, { persona: {} })
check('persist-reload', p2.get().preset === 'custom' && p2.get().custom.includes('实验室师兄'))

// 自定义为空时，轮换里不出现 custom
const p3 = createPersona(path.join(dir, 'empty'), { persona: {} })
const seen = new Set()
for (let i = 0; i < 7; i += 1) seen.add(p3.cycle().preset)
check('cycle-skips-empty-custom', !seen.has('custom'), [...seen].join(','))

// 称呼与禁忌进入人设段落，但不进入系统硬规矩
p.set({ preset: 'analyst', address: '阿泽', forbid: '作息、健康' })
const text = p.get().text
check('address-in-text', text.includes('「阿泽」'), text.slice(-30))
check('forbid-in-text', text.includes('作息、健康'))
check('rules-independent', rules('阿泽').includes('不做生活管教') && !rules('阿泽').includes('作息、健康'))
check('rules-address', rules('阿泽').includes('「阿泽」'))

// 长度与字符清洗：控制字符被替换，超长被截断
p.set({ preset: 'custom', custom: 'a'.repeat(400), forbid: 'b'.repeat(200), address: '一'.repeat(20) })
const capped = p.get()
check('custom-capped', capped.custom.length === 300 && capped.forbid.length === 120 && capped.address.length === 8, JSON.stringify({ c: capped.custom.length, f: capped.forbid.length, a: capped.address.length }))
p.set({ custom: '前面\u0007后面\u0000结束' })
check('control-chars-stripped', !/[\u0000-\u001f]/.test(p.get().custom), JSON.stringify(p.get().custom))

// 非法预设回落到默认，不会让插件起不来
p.set({ preset: '不存在的风格' })
check('invalid-preset-fallback', p.get().preset === 'companion')

// 每次 set 都落盘（文件存在且合法 JSON）
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))
check('file-json-valid', typeof raw.preset === 'string' && typeof raw.updatedAt === 'string')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
