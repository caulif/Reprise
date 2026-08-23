# ADR: Evidence-ranked dynamic recovery candidates

- 状态：Accepted
- 日期：2026-08-19
- 范围：Recovery investigation 与 candidate staging 编排

## 背景

旧实现固定创建 `current-workspace` 和 `historical-evidence` 两个候选。这样会在有更强的 preimage、patch 或 Git 事实时浪费分支预算，也会把弱证据误解为“不值得尝试”。

## 决策

Host 在隔离 staging 中根据已解析事实生成 evidence-ranked 候选种子，顺序为：

1. 机械验证的 preimage；
2. patch clue（即使 base 尚未验证，也保留低置信候选）；
3. 可用且有 present HEAD 的 Git history；
4. 冻结 transcript/historical observation；
5. current workspace 低成本 fallback。

每个种子都创建独立 candidate staging。默认选择列表中最高证据分支；其他候选不会被合并或覆写，而是在验证后丢弃并写入事件。`recovery.candidate_selected` 的 `selection` 为 `highest_evidence_first`。

弱证据允许进入调查、工具读取和候选生成，但不能单独满足 `verified` 或自动接受条件。源目录隔离、path boundary、evidence ownership、manifest/hash verifier 和 source tripwire 不变。

## 取舍与后续

本决策是从固定候选迈向候选图的第一步，不宣称完整图已完成。后续要持久化 hypothesis、candidate、evidence、verifier result 的边关系，并以信息增益、风险、成本和重复查询控制搜索停止；冲突事实保留互斥分支。

## 验证

`test/codex-experiment.test.ts` 覆盖同时存在 preimage、patch、Git 和 observation 的 fixture，断言五个隔离候选创建、preimage 分支优先、其他分支隔离丢弃、source 未改变及 selection rationale 事件。
