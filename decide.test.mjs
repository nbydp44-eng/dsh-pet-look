// 自动发言判定规则的单元测试：不联网、不截图。
import { evaluate, needsLook } from './lib/decide.js'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`) } else { fail += 1; console.log(`FAIL  ${name}  ${detail}`) }
}

const T = 0.45

// 1. 模型显式开口 + 高置信度
ok('speak-true-confident', evaluate({ scene: 'study', speak: true, text: '这一章讲矩阵的秩', confidence: 0.8 }, { threshold: T }).ok)

// 2. 真实日志里的形态：写了 32 个字，却把 speak 标成 false，置信度 0.4
ok('text-without-flag', evaluate({ scene: 'other', speak: false, text: '这个窗口里在改一段识别脚本的逻辑', confidence: 0.4 }, { threshold: T }).ok)

// 3. 空 text 一律不开口
ok('empty-text-quiet', !evaluate({ scene: 'study', speak: true, text: '   ', confidence: 0.9 }, { threshold: T }).ok)

// 4. 聊天场景强制安静
ok('chat-silent', !evaluate({ scene: 'chat', speak: true, text: '你在聊天', confidence: 0.9 }, { threshold: T, silent: true }).ok)

// 5. 编程场景未卡住不开口
ok('code-not-stuck', !evaluate({ scene: 'code', speak: true, text: '这段代码不错', confidence: 0.9 }, { threshold: T }).ok)
ok('code-stuck-speaks', evaluate({ scene: 'code', speak: true, text: '这个报错重复三次了', stuck: true, confidence: 0.9 }, { threshold: T }).ok)

// 6. 置信度低于地板不开口
ok('low-confidence', !evaluate({ scene: 'study', speak: true, text: '可能在写作业', confidence: 0.2 }, { threshold: T }).ok)

// 7. scene=other 且显式开口时要求 0.6
ok('other-self-low', !evaluate({ scene: 'other', speak: true, text: '大概在忙', confidence: 0.5 }, { threshold: T }).ok)
ok('other-self-high', evaluate({ scene: 'other', speak: true, text: '这段日志在报同一个错', confidence: 0.65 }, { threshold: T }).ok)

// 8. 人设门槛更高时，写了字但置信度不足也不开口
ok('persona-threshold', !evaluate({ scene: 'study', speak: false, text: '这段视频在讲火锅', confidence: 0.4 }, { threshold: 0.75 }).ok)

// 9. 安静观察型（门槛更低）在 0.35 附近仍可开口
ok('observer-floor', evaluate({ scene: 'study', speak: false, text: '这页在讲特征值', confidence: 0.36 }, { threshold: 0.25 }).ok)

// 10. 是否需要再看一眼：首次、明显变化、小幅变化、静止兜底、什么都不满足
const change = { significant: 8, minor: 4, minorMinGapSec: 240 }
const now = 1_800_000_000_000
ok('look-first', needsLook({ dist: 64, lastAnalysisAt: 0, now }).look)
ok('look-change', needsLook({ dist: 12, lastAnalysisAt: now - 60_000, now, change }).why === 'change')
ok('look-minor-wait', needsLook({ dist: 5, lastAnalysisAt: now - 300_000, now, change }).why === 'minor')
ok('look-minor-too-soon', !needsLook({ dist: 5, lastAnalysisAt: now - 60_000, now, change }).look)
ok('look-heartbeat', needsLook({ dist: 0, lastAnalysisAt: now - 601_000, now, change, heartbeatSec: 600 }).why === 'heartbeat')
ok('look-quiet', !needsLook({ dist: 0, lastAnalysisAt: now - 120_000, now, change, heartbeatSec: 600 }).look)

console.log(`\nSUMMARY ${pass}/${pass + fail}`)
process.exit(fail ? 1 : 0)
