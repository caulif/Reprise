# 决策：Recovery 文本简报、续接与 Playbook v2

状态：accepted
日期：2026-09-15

## 问题

Recovery 首条消息是 JSON 工作集，含 `schemaVersion`、`allowModelText`、超时等对模型无用的字段；跨进程新建 Session 时续接不到任务简报；observations `INDEX.md` 仍写信封 ref；Claude Code Playbook 混入 Pack 开发笔记；工具 description 含 Recovery 专属 ACL 与 staging 措辞。

## 决定

模型可见首包是 `# Recovery briefing` 文本，不是 `JSON.stringify` 工作集。Host 仍可用内部 JSON 对象计算 digest。`completedFreeformTurns > 0` 且 `RoleSessions.get` 返回新建 Session 时，把 resume 段与同一简报前置到第一条剩余委托。Playbook 版本为 `codex-recovery/v2` 与 `claude-code-recovery/v2`；Claude Code 的 CLI 与帧序列笔记只在 Pack README。`INDEX.md` 头部按导航与计数，不含信封 ref。Recovery 输出契约以共享 `STRUCTURED_FINAL_RULE` 起首。工作区工具 description 按受限 / 不受限读分写，不把 source ACL 写进工具句。本决定更新 [工作集与观察文件](./2026-09-07-recovery-working-set-and-observation-files.md) 与 [工具面、工作集证据](./2026-09-10-recovery-visible-capability-and-readiness-gates.md) 中「进模型的首包是 JSON 工作集」的条款；观察树、七件套与机械封存仍有效。

## 备选方案

**继续 JSON 工作集并收缩死字段。** 模型仍要调和对它无用的 Host 字段。

**续接只靠 notes.md，不重发简报。** 新 Session 在 notes 缺失时没有任务句。

**Playbook 继续夹带 Pack 运行时陷阱。** 占用 Recovery 上下文且与权限无关。

## 影响

understand / restore / conclude、压缩指令与 observations 索引对模型可见文本改变。跨进程续接必须带简报。Playbook SHA-256 随正文更新。

## 验证

`test/application/recovery-working-set.test.ts`：简报含 `# Recovery briefing` 与截断标记，不含 `schemaVersion` / `allowModelText` / `timeoutMs`。`test/application/recovery-envelope.test.ts`：两轮自由委托完成后新建 Session，第一条 append 含 `# Recovery briefing`。`test/products/codex-pack.test.ts` 与 `test/products/claude-code-pack.test.ts` 钉住 v2。`test/snapshots.test.ts` 重生成 `recovery-system-prompt.txt` 与 `recovery-tools.txt`。`npm run check` 必须通过。反向：两轮已完成且 Session 新建时首条不含 `# Recovery briefing` 则红。
