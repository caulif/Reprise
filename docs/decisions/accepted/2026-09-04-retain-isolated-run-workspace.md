# 决策：候选隔离副本在 cleanup 后保留

状态：accepted
日期：2026-09-04

## 问题

CandidateRun 结束时 `LocalWorkspaceProvider.release` 递归删除 `environment/runs/{runId}`。交付物（HTML、PPT、截图）只短暂存在于该树中；scope artifact 只保留有界文本快照。用户无法在对照结束后打开候选实际写出的文件。

## 决定

`release` 只从 Provider 的 prepared 表摘掉活动句柄，使后续 `fingerprint` 不再把它当作活动环境。隔离副本目录留在盘上。Host 不得因 stop、cancel、timeout、对照结束或实验 `finally` 删除该树。

失败的 `prepareRun` 半成品、Recovery staging、以及用户源目录的既有规则不变。

## 备选方案

**按 TTL 后台删除。** 把审阅窗口做成隐式过期，交付物会在用户回来前消失。

**只把变更文件拷到 artifacts 再删副本。** 二进制与大 HTML 仍会丢；路径与打开方式也和候选当时不一致。

**对照结束后再删。** 对照可以跳过；审阅发生在对照之后。

## 影响

磁盘占用随实验次数增长。显式清理另议，不在本次 cleanup 里做。对照沙箱仍从已提交 artifact 物化，不依赖删除副本。

## 验证

`test/environment.test.ts`：`release` 之后隔离根上的文件仍可读；第二次 `release` 为 `already_released`；`fingerprint` 仍因不再活动而拒绝。反向：若 `release` 再 `rm` 该根，读文件失败。
