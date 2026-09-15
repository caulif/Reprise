# 决策：Controller 英文提示词、notes/ 落盘与 steering 不重发 INDEX

状态：accepted
日期：2026-09-15

## 问题

Controller 的 System Prompt、轮次委托与 INDEX 把身份、工具规则和判断顺序叠在多层且中英混杂；理解轮结论只活在会话内存；steering 每轮重发整份 INDEX.md。`edit`/`write` 只认 `project/`，工作笔记无处可写。`send.message` 的语言轴已由 [内部 Agent locale](./2026-09-15-internal-agent-locale.md) 规定，本决定不重复。

## 决定

Controller 指令统一英文。System Prompt 组成顺序为角色正文、`# Workspace`、`LANGUAGE_BLOCK`、可见过程规则。understand 写入 briefing 根下 `notes/understanding.md`。`controllerProjectWriteAllowed` 允许第一段为 `notes` 或 `project` 且其下有文件的相对路径。`digestBriefing` 不收录 `notes/`。opening 的 `promptContent` 含完整 INDEX.md；steering 只含决策段、`briefingRoot`、`phase=steering` 与 `Latest turn:` 行。INDEX.md 只做导航。`permissions.txt` 为 `controller.writes=project,notes`。本决定更新 [协作工具面](./2026-09-10-controller-collaboration-workspace-tools.md) 中「只对 `project/` 写」的条款；发给候选的唯一用户输入仍是信封 `message`。

## 备选方案

**理解结论只留在 Session。** 压缩后不可重读。

**steering 继续附 INDEX 全文。** 与 opening 重复，修复轮也重发整图。

**notes 进 digest。** 把工作笔记当成 Host 事实，与「Host 不读、不据此拒绝 done」冲突。

## 影响

模型可见 Controller 文本与 briefing 写权限改变。Host 不校验 `notes/understanding.md` 是否存在，也不据此拒绝 `done`。`send.message` 命中 Host 术语则拒绝，这是事实完整性护栏，与 `notes/` 写权限无关。

## 验证

`test/application/controller-tools.test.ts`：写 `notes/understanding.md` 允许，写 INDEX 与 `history/` 拒绝。`test/application/controller-briefing.test.ts`：opening 后存在空的 `notes/` 目录；digest 不含 `notes/` 键；steering `promptContent` 不含 `# INDEX.md`。`test/application/controller-opening.test.ts`：`send.message` 含 Host 术语则失败。`test/core/snapshots.test.ts` 重生成 `controller-system-prompt.txt`。`npm run check` 必须通过。反向：steering 含 `# INDEX.md`、briefing 根下非 `notes/`/`project/` 写入被接受、或 `please continue` 被当成 Host 术语拒绝则红。
