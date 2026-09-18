# 决策：内部 Agent 输出语言随操作者 locale；候选可见面不受 locale 影响

状态：accepted
日期：2026-09-15

## 问题

内部 Recovery、Controller、Comparison 的面向操作者文本没有读取 TUI locale，因此输出语言与界面语言脱节。若把操作者语言写进发给候选的消息，会污染「同等人类能力」条件。

## 决定

TUI 与 CLI 无头路径读取同一份 `{dataDir}/tui-preferences.json`，缺省 locale 为 `zh`。CLI `--locale <en|zh>`（别名与 preferences 相同：`english`、`zh-cn`、`chinese`、`中文`）覆盖该 dataDir 的操作者语言，并在创建 workflow / TUI 之前写入同一份 preferences，使界面与内部 Agent 一致。未知值是 usage 错误，不静默当成 `zh`。`createHarnessWorkflow({ locale })` 若传入 locale，用它构造 Agent，而不再读 preferences。`createHarnessAgents` 把 locale 传给三个内部 Agent；各自在现有 System Prompt 末尾追加 `LANGUAGE_BLOCK`。locale 不进入 Session 基础设施，也不新增事件：`agent.session_started` 已记录完整 systemPrompt。Controller `send.message` 跟随历史用户当时的语言，不切换为操作者语言。locale 不冻结进 ExperimentSpec。

## 备选方案

**把 locale 记进 Session 事件。** 与已有 systemPrompt 审计重复。

**把 locale 写进 ExperimentSpec。** 把操作者偏好当成实验条件。

**指令与输出都随 locale。** 工具 description、INDEX 与契约无法只维护一种语言。

## 影响

默认界面与内部 Agent 操作者输出为简体中文。`--locale` 写入 `{dataDir}/tui-preferences.json`，后续 TUI 与无头路径沿用该 dataDir 的偏好，直到再次切换。候选可见消息、引用原文、路径与标识符不翻译。application 读取 preferences 文件而不 import tui；CLI 可 import tui 的 `saveTuiPreferences` 做持久化。

## 验证

`test/application/harness-agents.test.ts`：locale=`en` 的 System Prompt 含 `English`，locale=`zh` 含 `Simplified Chinese`。`test/cli/cli.test.ts`：`--help` 含 `--locale`；非法 `--locale` 为 usage 并列出允许值；`--locale en` 在打开 TUI 前把 preferences 写成 `en`；headless `prepare`/`run`/`compare` 非法 locale 为 usage。`test/core/snapshots.test.ts` 快照含默认 `zh` 语言块。`npm run check` 必须通过。
