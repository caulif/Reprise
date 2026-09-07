# 决策：Controller briefing 可复原清单与无进展策略解耦

状态：accepted

## 问题

Controller 需要按需读取历史和候选轨迹，且压缩或恢复后仍能确认可读文件的版本。Target 的无进展策略不能限制 Controller 的合法重复澄清。

## 决定

- 每个 Controller briefing 维护 Host-owned `manifest.json`，记录可读文件的相对路径、字节数和 SHA-256；请求快照通过 manifest 的文件摘要证明输入版本，不把全文重新注入 prompt。
- briefing 在 opening 和每次 settled turn 后原子刷新 manifest；候选仍无权写入 briefing。
- understanding 初始结果同时写入 schema 校验的 `controller-understanding.json`。后续 decision 可提交 merge/replace 增量；Host 原子更新语义账本和 Markdown 投影，并记录更新事件。增量不能改变运行状态机。
- `RunPolicy.maxConsecutiveNoProgress` 不再用于比较 Controller 消息。Controller 仅受其显式 Agent budget 和用户取消、墙钟等终止条件约束。
- 每个 settled turn 额外生成 `event-index.tsv`；Controller 完成时记录 advisory completion diagnostic，报告读取证据数量但不因未读取而拒绝 `done`。

## 备选方案

**沿用 Target 的无进展计数器**：会阻断 Controller 合法的重复澄清，因此不采用。

## 影响

Manifest 是取证索引，不是语义摘要，也不替代事件日志或工作区 fingerprint。缺失文件仍需由读取工具报告，不能用 manifest 中的零值推断“无变化”。

## 验证

Controller briefing 测试验证 manifest 的路径、大小和 64 位摘要；实验测试验证重复用户消息可继续进入下一轮。
