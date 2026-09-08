# 决策：场景封存发布边界与重复运行

状态：accepted

目标批次见 [M2.3](../../plan/reprise-refactoring-execution.md#m23-场景封存与重复运行)。

## 问题

封存场景若在 `prepareRun` 后丢掉 provider 基线，第二次运行会再从活源目录推导起点；源搬走后无法重放。History 读取还会删掉无 run 目录时的 baseline 树。对照若把 `runs/{runId}` 活动副本当成终态，候选结束后的继续写入会冒充对照输入。半成品 `case.json`（无 `case.complete`）若出现在可选列表中，会被当成可运行场景。

## 决定

- 发布边界：`case.complete` 存在才是可列出、可运行的 TaskCase；staging 与缺标记目录不是场景。`persistTaskCase` 在已发布树上只核验不可变内容，对未完成目录拒绝，对缺失目录走 `publishFrozenCase`。
- 封存 baseline 留在 `baselines/{caseId}` 与 sibling marker。`prepareRun` 只复制到新的 `runs/{runId}`，不删除封存。源目录缺失时 `resolveBaseline` 只读封存树；fingerprint 与 marker 不符或文件缺失则拒绝运行。
- 候选结束、release 之前，把工作区复制到 `snapshots/{runId}` 并写 `{runId}.complete`。Comparison 的 `candidate/` 只挂该封存；快照未完成则挂 `candidate-snapshot-unavailable`，不把活动 `runs/{runId}` 当终态。结果页仍可打开隔离副本供人审阅。

## 备选方案

**每次 run 从活源再 copy。** 源搬走或被改写后无法重复，且两次起点可能漂移。

**对照继续挂活动副本。** 释放后的目录仍可被改，终态与对照输入不是同一棵树。

**History 继续回收 baseline 以减小体积。** 封存场景无法独立于源目录重跑。

## 影响

Comparison system prompt 写明 `candidate/` 是封存快照。结果页打开 `environment/runs/{runId}` 的约定不变，见 [结果页打开隔离副本](./2026-09-04-result-replica-open-and-comparison-live-mount.md)。

## 验证

`test/scene-seal.test.ts`：源搬走后封存可跑；指纹不符拒绝；半成品不进列表；`persistTaskCase` 拒绝未发布目录；对照 incomplete 不挂 live run。`test/environment.test.ts`：两次 `prepareRun` 起点指纹相同且互不污染。`test/local-history.test.ts`：列出 History 不删除封存 baseline。`test/comparison-report.test.ts` 与 snapshot：prompt 含 sealed snapshot，不含 live isolated replica。反向：缺 `case.complete` 的目录出现在列表、或 incomplete 快照仍挂 `runs/{runId}` 则红。
