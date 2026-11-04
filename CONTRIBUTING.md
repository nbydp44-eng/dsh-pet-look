# 贡献指南

## 基本原则

1. **隐私是硬约束**：任何 PR 都不得削弱本地隐私门、日志脱敏、截图生命周期。
2. **不新增运行时依赖**：插件必须只依赖 Node 内置模块，截图/OCR 走 PowerShell 系统能力。
3. **不改原桌宠**：不修改 `dsh-pet` 的源码或渲染；只使用它公开的 HTTP API。
4. **小步改动**：一个 PR 只解决一件事，附带对应测试。

## 开发环境

- Windows 10/11 + PowerShell 5.1（系统自带）。
- Node.js ≥ 20。
- 本机装有 DSH Desktop 时，可用 `_probe-look/harness*.mjs` 做真截图/真 OCR 集成测试。

## 提交流程

```bash
npm test        # 离线测试，必须全绿
npm run check   # 语法检查
```

如果改了截图、隐私门或调度逻辑，还应运行：

```bash
set DSH_WEB_URL=http://127.0.0.1:<你的 DSH 端口>
node _probe-look/harness.mjs
node _probe-look/harness-resilience.mjs
```

## 代码约定

- ES Module（`"type": "module"`），不引入 TypeScript 构建步骤。
- 每个模块单一职责：`capture` 只负责截图、`vision` 只负责模型调用、`persona` 只负责说话风格。
- 面向用户的文案用中文；代码注释解释「为什么」，不解释「是什么」。
- 新增日志 code 必须是固定枚举，不得包含屏幕文字、OCR 结果或聊天内容。

## 隐私相关改动

涉及截图、OCR、上传路径的改动，PR 描述里必须回答：

- 截图在哪里产生、存放多久、由谁删除？
- 失败时是否 fail closed？
- 日志里会不会多出任何正文？

## 文档

- 用户行为变化 → 更新 `README.md`。
- 对外行为变化 → 更新 `CHANGELOG.md`。
- 隐私行为变化 → 更新 `docs/privacy.md`。

## 提交信息

```
<type>: <一句话说明>

type ∈ feat | fix | docs | test | chore | perf | refactor
```

## 行为准则

- 不提交任何真实截图、日志、个人信息、API Key。
- 测试用的敏感画面必须是合成图（参考 `_probe-look/gate-shot.mjs`）。
