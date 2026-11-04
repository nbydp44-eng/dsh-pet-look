import { __test } from './lib/vision.js'
const { parseReply } = __test
const cases = [
  ['正常', '{"scene":"other","speak":true,"text":"主人，已经很晚了，早点休息。","stuck":false,"confidence":0.6,"memory":null}'],
  ['尾随花括号', '{"scene":"other","speak":true,"text":"主人，先喝口水吧。","stuck":false,"confidence":0.6,"memory":null}\n{'],
  ['字符串内换行', '{"scene":"other","speak":true,"text":"主人，\n早点休息。","stuck":false,"confidence":0.6,"memory":null}'],
  ['代码块', '```json\n{"scene":"code","speak":true,"text":"这里报错了，先看日志。","stuck":true,"confidence":0.7,"memory":null}\n```'],
  ['纯文本', '主人，桌面上好像没开什么程序呢。'],
  ['超长', '{"scene":"other","speak":true,"text":"' + '主人今天一直在看代码，' .repeat(6) + '","stuck":false,"confidence":0.5,"memory":null}'],
]
for (const [name, raw] of cases) {
  const r = parseReply(raw, false, 42)
  console.log(name, '=>', JSON.stringify({ ok: r.ok, text: r.text, len: r.text?.length, scene: r.scene }))
}
