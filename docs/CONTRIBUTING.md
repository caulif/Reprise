# 贡献指南

先读根 [`README.md`](../README.md) 和本文件，再读任务触及的 [`AGENTS.md`](../AGENTS.md)、[`src/AGENTS.md`](../src/AGENTS.md) 或 [`docs/AGENTS.md`](./AGENTS.md)。产品与架构以 [`docs/README.md`](./README.md) 导航的规范为准，不要在 PR 里复制它们。

**Node.js `>=22.19.0`** 是运行时基线。CI 的 test matrix 覆盖 Windows、macOS 和 Ubuntu，作为可移植性回归门禁；真实 Runtime smoke、TUI 帧和平台专用权限行为仍需在目标宿主上显式验证。其他未列入 CI 的 OS 上的失败可报告，不构成回归门禁。

## 开发环境

```text
npm ci
npm run check
```

不要提交 `.reprise/`、凭据、真实 smoke 输出或本地数据目录。Harness 模型密钥只存在本机 Git 忽略的 `.reprise/harness-model.json` 或 `env:NAME`；官方登录只在 Pi `auth.json`。不得打印、复制进事件、artifact、报告或 PR。Reprise 不读取、不保存 Codex CLI 凭据。

## 验证命令

| 改动 | 本地命令 | 不要跑 |
|---|---|---|
| 仅 `docs/` | `npm run verify:docs` | `npm run check`、真实 smoke |
| TypeScript / 测试 / 脚本门禁 | `npm run check`；窄回归可用 `npm run build` 后对受影响的 `dist/test/**/*.test.js` 跑 `node --test` | 真实 Runtime smoke |
| Schema / 事件 / on-disk / 提示词 / 工具面 | 完整 `npm run check`，并新增或更新 `docs/decisions/` | 手改生成文档 |
| Pack / Runtime / 凭据 | 完整 `npm run check` 加 fixture | 未 opt-in 的真实 smoke |
| TUI 渲染 | `npm run audit:tui:check` | 在 Ubuntu 上期待帧逐字节一致 |

真实 Codex / Claude smoke 必须显式设置环境变量（见 [`codex-smoke-gate.md`](./codex-smoke-gate.md) 与根 README）。默认路径不得产生外部费用；CI 默认也不跑它们。

## 任务入口

非平凡改动先有 Issue 或填写 [`plan/task-brief-template.md`](./plan/task-brief-template.md)。Done-means 写成命令、fixture、期望退出码或快照，不要写「验证通过」。协议、持久化、提示词或工具面变化必须带 decision。

## 提交与 PR

- 提交说明只描述实际变更，不用「完成全部优化」这类标题。
- PR 使用 [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)。跳过的检查必须写原因。
- generated docs 只改源和生成命令，不手改产物。
- Agent 提交的 PR 必须由人类确认：审查代码与日志，不把 agent 报告、截图或未复现的 smoke 当作唯一证据。

## 发布与回滚

用户可见变更写入 [`CHANGELOG.md`](./CHANGELOG.md)。发 npm 包前走 [`release-checklist.md`](./release-checklist.md)。回滚优先 `npm deprecate` 故障版本并安装上一版本；on-disk 不兼容时按 changelog 的迁移回退步骤操作，不要在用户数据目录上做无备份删除。

## Agent 输出

agent 在收尾时给出：摘要、改动文件、验证命令与结果、未验证风险、是否涉及协议/持久化/提示词/工具面、是否需要 decision。跨会话事实写入 Issue 或 [`progress/MASTER.md`](./progress/MASTER.md)，不要把「已实现/待办」复制到多份文档。

## 文档与 coding agent 维护

任务先声明“当前行为修复”或“目标迁移批次”，按[文档导航](./README.md)读取对应规范，不批量加载全部 ADR。行为、输入契约或存储变化同批更新其唯一归宿；prompt 和类型改代码源，不在文档复制全文。完成证据链接提交或 PR 与可复现命令，不能只留在聊天或本机 HTML 中。

PR 说明文档归宿是否变化；无需更新时解释原因。维护者检查目标是否被误写为已可用命令，旧规则是否已按迁移边界处理，演示数据是否冒充真实验证。每次发布核对活跃计划与支持声明，已结束的计划退出活跃目录。规则见[文档生命周期](./documentation-structure.md#防止漂移)。

## 审查顺序

先范围与 YAGNI，再契约与 owner，再失败与安全，再证据，最后简化。提示词、工具面、事件和 on-disk 格式必须能链到 decision 与回归测试。
