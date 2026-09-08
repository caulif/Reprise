# 决策：跨终端 cancel 本机端点

状态：accepted

目标批次见 [M6.2](../../plan/reprise-refactoring-execution.md#m62-跨终端-cancel)。

## 问题

第二进程的 `cancel` 只能查本进程活动表。不可达时若删 `writer.lock` 或按历史 PID 杀进程，会接管未完成写者或误杀复用 PID。

## 决定

- 活动所有者在 `dataDir/ipc/<ownerInstanceId>/` 启动本机端点：Windows 命名管道，POSIX Unix socket（目录 0700）。不监听 TCP。
- 认证 token 只写在该目录 `token`（0600），不进入 `control.json`、事件、CLI JSON 或报告。`experiments/<id>/control.json` 只含当前 operation、owner 实例、pid 与端点地址。
- 客户端按 `--data-dir` 查找记录并发送 `{protocolVersion, command: cancel, token, ownerInstanceId, operationId}`；长度超过 4096 字节拒绝。实际取消与终态由 owner 执行。
- 请求绑定当前 `operationId`。已结束操作写 `control-ops/<operationId>.json`，取消旧 id 返回 `already_finished`，不取消下一 prepare/run/compare。
- 重复 cancel 对进行中操作幂等（`accepted` / `cancel_requested`）。端点不可达、超时、认证失败不删锁、不 `process.kill`、不接管写者。
- 只读观察者没有 `registerActivity`，退出不取消其他进程的 owner。同实验写者仍由 `writer.lock` 互斥；不同实验目录可并行。

## 备选方案

**未鉴权 TCP。** 局域网可取消他人实验。

**客户端删锁或按 PID 终止。** PID 复用会杀错进程，崩溃残留锁会被误回收。

## 影响

`reprise cancel` 解析 `--data-dir`（默认 `REPRISE_DATA_DIR` 或 `.reprise`）。进程内活动仍优先处理。比较与候选在同实验仍互斥。

## 验证

`test/control-ipc.test.ts`：第二进程取消 prepare/run/compare 且 `writer.lock` 不变；错误 token 不取消；死端点 unreachable 且锁仍在；旧 operationId 不取消下一 run。反向：客户端 `taskkill`/`process.kill`/`writer.lock` 或 `listen(port)` 则红。
