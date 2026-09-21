# 决策：历史只读重开与格式兼容

状态：accepted

延续 [模型输入重建](./2026-09-08-model-input-reconstruction.md) 与 [生命周期](./2026-09-08-session-invocation-lifecycle.md)。目标批次见 [M1.4](../../plan/archive/reprise-refactoring-execution.md#m14-历史兼容与只读重开)。

## 问题

新事件带 versioned 正文，旧日志只有长度或把 `agent.session_completed` 当成一次请求成功。History 若只读 `record.json` 或凭 `writer.lock`/PID 猜测候选已停，崩溃后会显示错误终态，或在只读浏览时实例化 Pack 与 Runtime。

对照产物侧：磁盘上可能同时留下本次 `comparison-failure.html` 与更早的 `report.html`。若 History 只在 `comparison.status === "failed"` 时优先诊断，并把其余路径默认标成成功 Report，取消或未知对照会被旧报告伪装成成功。

## 决定

事件信封与模型正文的当前写入版本是 `schemaVersion` 1。读取时：版本 1 按字段解释；缺少正文的旧 `agent.message_appended` 标为不完整并显示“该记录未保存完整内容”，不补写推测过程；未知版本返回 `unsupported_schema` 并停止消费后续行；非法 JSON 与半行仍只保留已提交前缀。不在打开 History 时重写事件日志。

旧日志里若某 Session 在没有任何 `agent.invocation_*` 终态后出现 `agent.session_completed`，只读解释为当时那次请求已结束，不等于今天的 Session 关闭语义，也不生成假的模型输出。

History 与 `readCommittedModelLog` 只读 `events.jsonl` 和已提交附件。不 acquire writer、不实例化 provider / Runtime / Product Pack、不发模型请求、不启动候选。CandidateRun 是否中断或未知只看已提交事件（`run.finished` 或 `run.attempt_created`），不看锁文件或 PID。

`HistoryExperiment` 是 application→TUI 的最小只读投影，不改 on-disk 布局。对照产物选择由 `selectComparisonArtifacts` 统一（只决定磁盘路径与归属，不存英文 UI kind）：

1. `failed` / `cancelled` 或其它非 `completed` 状态：优先本次诊断 HTML；仅有旧 `report.html` 时打开该文件并置 `reportAttemptUnconfirmed`，不得当作已确认成功报告。
2. `comparison.json` 存在但未通过 schema：已有 HTML 一律 `reportAttemptUnconfirmed`。
3. `completed`：打开 `report.html`；嵌套 `value.status === "insufficient_evidence"` 写入 `comparisonDetail`。开打标签由 T01 `deriveResultPresentation` 决定（证据不足显示诊断语义）。
4. 诊断与此前成功报告可同时暴露（`reportPath` + `previousReportPath`）；`previousReportPath` 仅保留成功 HTML；不删除或改写旧 HTML。
5. 实时 `showRunResult` 构造的 `recentExperiment` 与 History 读取共用同一投影字段（含 task/cleanup/comparison），缺字段保持省略，不默认成功。历史详情经 `deriveResultPresentationFromHistory` 消费 T01 presentation；点击 OSC-8 打开被点中的 HTML 路径。

## 备选方案

**启动时把旧日志改写成新正文格式。** 无备份的原地迁移会在半失败时毁掉唯一事实源。

**凭 writer.lock 或 PID 判断候选已停止。** 锁只保护写者互斥，不能证明 Runtime 或 CandidateRun 终态。

**History 走 inspectRun 与 Pack。** 只读重开会加载产品适配并可能触发外部行为。

**按文件名把任何 `report.html` 当成本次成功。** 取消/失败后旧报告仍在磁盘时会把取消伪装成完成。

## 影响

无 `record.json` 的实验在 History 上显示 interrupted/unknown，而不是空白 incomplete。TUI 对缺正文请求展示固定缺口文案。写入路径仍只写版本 1。History 详情与首页 recent 使用相同对照产物语义；结果页 presentation（T01）应消费同一事实字段。

## 验证

`test/agent-model-input.test.ts`：未知信封/正文版本失败；旧 `session_completed` 不发明 assistant 文本。`test/local-history.test.ts`：无 record 时按事件标 interrupted，不改 lock；cancelled + 旧 report / diagnostic；insufficient_evidence；cleanup unknown；非法 comparison.json；失败 kind 展示。`test/application/history-result-facts.test.ts` / `comparison-artifacts`：产物选择与 live 投影。`test/tui/history-result-presentation.test.ts`：live/history presentation 一致；此前报告点击打开对应路径。`test/widgets.test.ts`：中文详情含“该记录未保存完整内容”。`test/architecture.test.ts`：历史读模块不导入 Pack。既有 store 半行修复测试继续成立。
