# 决策：recovered 缺路径级强证据时收成 partial

状态：superseded

被 [单工作副本自主三轮循环](../accepted/2026-09-09-recovery-single-workspace-agent-loop.md) 取代。下文冻结。

状态：superseded
日期：2026-09-07

## 问题

模型用 `shell_exec` 按 transcript 起始目录清掉隔离工作区里的后继产物，fingerprint 已有任务路径变更，Verifier 也是 `pending_user_review`。信封却自称 `recovered`，而 transcript 目录快照不是路径级强证据。`validateManifest` 抛错后 `validateRecovery` 丢掉 staging；确认页没有 preview，`changedPathCount` 为 0，文案变成「没有观察到隔离工作区变更」。

## 决定

`recovered` 仍要求每条 fingerprint 任务路径都有强证据。探测与校验时，若 `recovered` 且任务路径非空、但任一条没有强证据，Host 把信封收成 `partial`，写入一条 Host unresolved，按 fingerprint 预览并走既有自动 accept。无任务路径变更的 `recovered` 仍拒绝。不把 transcript 目录列表提升为强证据。

## 备选方案

**继续整单拒绝。** fingerprint 回退被丢掉，操作者看到的是空变更，与事实相反。

**把目录快照当强证据。** `recovered` 与 Git blob / preimage 哈希的对应被放宽。

**只改确认页文案。** 仍没有 accept，无法开跑。

## 影响

过声称 `recovered` 的清理型回退会作为 `partial` 进入确认页。真正的 `recovered`（每条路径有 Git/preimage/checkpoint 哈希）行为不变。

## 验证

`test/environment.test.ts`：`recovered` 加工作区变更但只有弱证据时 preview 为 `recovered_partial` 且可 accept。反向：无变更的 `recovered` 仍拒绝；Git checkout 且有 commit 哈希的 `recovered` 仍为 `recovered`。
