# 决策：Controller 完成判断的交付与证据护栏

状态：superseded

被 [opening 同 Session](./2026-09-08-controller-opening-single-session.md) 取代，后者再被 [先理解再按视图决策](../accepted/2026-09-09-controller-understand-then-view.md) 取代。下文冻结，描述被放弃的 Host 完成证据护栏。

## 问题

Controller 可能把候选自述、旧账本或无关读取误判为任务完成，导致 Harness 记录不真实的 satisfied。

## 决定

Controller 的理解账本生成 Host-owned `controller-contract.json`。在拥有理解账本的当前实现中，satisfied 需要读取本轮候选结果，且 ledger 没有未解决事项；workspace `read` 可以登记证据，不依赖 `read_observation`。

拒绝完成的次数耗尽不是任务完成证据。有限纠错后由 Harness 明确停止，不能把拒绝上限转换为完成。没有 understanding 合同的旧脚本 Controller 保持兼容行为。

## 备选方案

**拒绝两次后接受完成。** PPT 实验表明它无法清除旧账，也会在缺证据时接受 satisfied。

## 影响

该护栏只保护外部任务完成状态的真实性，不限制候选工具，也不替模型判断内容质量。后续 Session-first 重构必须以新的事件和业务证据边界替代这一当前实现细节。

## 验证

`2026-09-06-ppt-flow-convergence-and-observation-bounds.md` 中的 ledger、候选结果读取和纠错回归覆盖当前实现；最终工程验证使用 `npm run check`。
