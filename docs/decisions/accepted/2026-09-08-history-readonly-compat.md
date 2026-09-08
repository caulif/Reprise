# 决策：历史只读重开与格式兼容

状态：accepted

延续 [模型输入重建](./2026-09-08-model-input-reconstruction.md) 与 [生命周期](./2026-09-08-session-invocation-lifecycle.md)。目标批次见 [M1.4](../../plan/reprise-refactoring-execution.md#m14-历史兼容与只读重开)。

## 问题

新事件带 versioned 正文，旧日志只有长度或把 `agent.session_completed` 当成一次请求成功。History 若只读 `record.json` 或凭 `writer.lock`/PID 猜测候选已停，崩溃后会显示错误终态，或在只读浏览时实例化 Pack 与 Runtime。

## 决定

事件信封与模型正文的当前写入版本是 `schemaVersion` 1。读取时：版本 1 按字段解释；缺少正文的旧 `agent.message_appended` 标为不完整并显示“该记录未保存完整内容”，不补写推测过程；未知版本返回 `unsupported_schema` 并停止消费后续行；非法 JSON 与半行仍只保留已提交前缀。不在打开 History 时重写事件日志。

旧日志里若某 Session 在没有任何 `agent.invocation_*` 终态后出现 `agent.session_completed`，只读解释为当时那次请求已结束，不等于今天的 Session 关闭语义，也不生成假的模型输出。

History 与 `readCommittedModelLog` 只读 `events.jsonl` 和已提交附件。不 acquire writer、不实例化 provider / Runtime / Product Pack、不发模型请求、不启动候选。CandidateRun 是否中断或未知只看已提交事件（`run.finished` 或 `run.attempt_created`），不看锁文件或 PID。

## 备选方案

**启动时把旧日志改写成新正文格式。** 无备份的原地迁移会在半失败时毁掉唯一事实源。

**凭 writer.lock 或 PID 判断候选已停止。** 锁只保护写者互斥，不能证明 Runtime 或 CandidateRun 终态。

**History 走 inspectRun 与 Pack。** 只读重开会加载产品适配并可能触发外部行为。

## 影响

无 `record.json` 的实验在 History 上显示 interrupted/unknown，而不是空白 incomplete。TUI 对缺正文请求展示固定缺口文案。写入路径仍只写版本 1。

## 验证

`test/agent-model-input.test.ts`：未知信封/正文版本失败；旧 `session_completed` 不发明 assistant 文本。`test/local-history.test.ts`：无 record 时按事件标 interrupted，不改 lock。`test/widgets.test.ts`：中文详情含“该记录未保存完整内容”。`test/architecture.test.ts`：历史读模块不导入 Pack。既有 store 半行修复测试继续成立。
