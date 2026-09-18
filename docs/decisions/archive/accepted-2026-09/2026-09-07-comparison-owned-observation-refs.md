# 决策：Comparison 信封承认挂载的观察 ref

状态：accepted
日期：2026-09-07

## 问题

Comparison briefing 把冻结 transcript、historical events 和本 run 事件写成 `observations/`，`process-index.tsv` 每行还给出 `event:{eventId}`。Reporter 按这些 Host 标签填 `evidenceRefs`。校验白名单却只有 baseline/candidate/artifact 投影，不含观察树。整份已写好的 `report.html` 因 `unknown evidence reference` 被丢掉。

## 决定

Host 单独持有 `ownedEvidenceRefs`：`recoveryEvidenceCatalog` 的 transcript/history ref，加上本 run 事件 `event:{eventId}`。它进入信封校验，不写入 briefing `context.json` 或对照输入快照。信封里属于该集合的 ref 保留；夹杂的未知 ref 丢掉；全部未知则仍拒绝。不把完整 catalog 塞进模型 briefing。

## 备选方案

**只改提示让模型只抄 briefing 里的少数 ref。** 模型已经按 INDEX / process-index 引用，提示无法覆盖 Host 自相矛盾的标签。

**未知 ref 一律放行。** 伪造引用会进入 envelope。

**把全部 event id 写进 briefing JSON。** 拉长模型输入，且与工作集决策相反。

## 影响

对照报告可以引用它实际读过的观察文件。伪造且无法对应挂载树的 ref 仍会使信封失败。

## 验证

`test/comparison-report.test.ts`：owned 观察 ref 通过；仅 `event:foreign-1` 拒绝。`test/comparison-agent-phases.test.ts`：owned+unknown 完成且只保留 owned。反向：仅未知 ref 仍 `invalid_output`。
