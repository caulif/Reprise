# 决策：删除 Recovery Diagnosis Agent

状态：accepted
日期：2026-09-15

## 问题

轻量 Diagnosis Agent 在 Recovery 失败后再调一次模型：`allowModelText: true` 硬编码，输入几乎只有 Host 回退文案，对已有 `summary` 再改写一遍，并在 `allowModelText=false` 的 TaskCase 上旁路隐私策略。

## 决定

删除 Diagnosis Agent 及其 `RecoveryDiagnosisContext` / `RecoveryDiagnosisResult`。Agent 已返回的 `blocked`/`ready` 使用信封 `summary`，Host 不改写。Agent 未产出的失败由纯函数 `failureExplanationKey` 映射到 TUI i18n 键，写入 `recovery-explanation.json`（`diagnosis` 为 `"host"` 或省略）。`recovery-diagnosis.json`（`RecoveryAttemptDiagnosis`）仍是用户终态产物，保留。

## 备选方案

**保留 Diagnosis 但关掉隐私旁路。** 仍是一次无增量的模型调用。

**给 Recovery 加第四轮解释轮。** 把同一职责搬回同一 Session。

Diagnosis Agent 没有单独的 accepted 引入记录，本文件即删除约束。

## 影响

失败解释随 TUI locale 渲染，不再出现英文 Host 错误直接上屏。隐私阻止的 TaskCase 失败不再产生 Diagnosis 的 `agent.session_started`。

## 验证

`test/application/recovery-explanation.test.ts`：blocked 的 TUI 句子等于 Agent summary；`allowModelText=false` 时无 `agent.session_started`、无模型调用。删除 `src/agents/diagnosis-agent.ts`。`npm run check` 必须通过。
