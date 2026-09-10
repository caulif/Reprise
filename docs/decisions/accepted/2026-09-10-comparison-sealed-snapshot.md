# 决策：Comparison 封存快照与失败报告保留

状态：accepted

## 问题

对照若挂载活动 `runs/{runId}`，或失败时覆盖已成功的 `comparison.json` / `report.html`，会把未封存 workspace 或失败结果当成终态。

## 决定

Comparison 只挂载 Environment 封存快照。`snapshotStatus` 为 incomplete/missing 时挂载 unavailable 目录，并在资料索引与 `SNAPSHOT.txt` 写 `incomplete` 或 `unknown`。失败或取消只写 `comparison-failure.html`，不得覆盖已发布的 `report.html`。`comparison.json` 记录最近一次 attempt。

## 备选方案

**把活动 run 目录当对照终态。** 后续 mutation 会污染对照输入。

## 影响

persisted comparison 与在线收尾共用 `candidateSnapshot`。

## 验证

`test/application/scene-seal.test.ts` 与 `test/application/codex-experiment.test.ts` 覆盖 incomplete 不挂载 live run、失败对照不覆盖 `report.html`。

