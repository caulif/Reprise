# Controller 完成判断的交付与证据护栏

本记录的拒绝上限策略由 [Controller 内部完成纠错与有界证据分页](./2026-09-06-ppt-flow-convergence-and-observation-bounds.md) 的决定替代，有效规则以该决策为准。

Controller 的理解账本生成 Host-owned `controller-contract.json`。完成证据门保护任务完成判断：当前请求必须读取本轮候选结果，且 ledger 没有未解决事项。workspace `read` 可登记证据，不依赖 `read_observation` 工具。

本记录最初选择“拒绝两次后接受完成”作为止损方案。PPT 实验说明它既不能清除旧账，也可能在缺证据时接受 satisfied，因此被有限 Controller 内部纠错和 Harness 明确终止取代。拒绝次数耗尽不是任务完成的证据。

该护栏只保护外部“任务完成”状态的真实性，不限制候选可使用的工具，也不替模型判断内容质量。没有 understanding 合同的旧版脚本 Controller 保持兼容行为。
