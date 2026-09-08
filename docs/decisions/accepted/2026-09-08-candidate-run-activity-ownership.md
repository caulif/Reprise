# 决策：CandidateRun 活动所有权与写锁

状态：accepted

目标批次见 [M2.4](../../plan/reprise-refactoring-execution.md#m24-candidaterun-与活动所有权)。

## 问题

CandidateRun 状态必须只经 `assertTransition` 写入。UI 回调若直接改状态，事件日志不再是唯一事实。未知投递若重发会重复副作用。prepare / run / compare 若共用模糊 ID，取消会打到下一操作。写锁若按 PID 消失自动回收，异常关闭会被另一进程接管并改写事实。全 dataDir 一把锁会把无关实验串行化。

## 决定

- CandidateRun 先提交 attempt/manifest 和 `input.submitted`，再调用 Runtime。状态只在 CandidateRun 内转换。TUI 只订阅事件。
- `accepted` / `rejected` / `unknown` 保持协议语义；`unknown` 与 `rejected` 进入终态，相同 `clientMessageId` 不重发。
- 进程内活动表登记 `operationId`（`op-prepare|run|compare-…`）、`experimentId`、`runId`。`reprise cancel <id>` 解析这三类身份。已结束的 operationId 返回 already_finished，不取消后续操作。第二进程经本机端点请求当前 owner；不可达、过期或认证失败不删除 `writer.lock`、不按历史 PID 杀进程。端点规则见[跨终端 cancel](./2026-09-08-cross-terminal-cancel.md)。
- `run.cancel_requested` 与终态取消分开。取消与自然完成竞态时，先进入 `#finish` 的结果保留；晚到 delivery/settlement 不改写终态。
- `writer.lock` 在实验目录。存在即拒绝新写者，不按 PID、TTL 或损坏内容自动夺锁。不同实验目录可并行持锁。

## 备选方案

**PID 不存在则回收锁。** 崩溃后可继续写，但会接管未完成操作并可能改写终态。

**取消实验 ID 即取消该实验此后一切操作。** 取消请求会漂移到下一 prepare/run/compare。

## 影响

CLI 增加 `cancel` 子命令。锁文件残留需人工删除后才能再写该实验。对照与候选在同实验内仍互斥，因同一 `writer.lock`。

## 验证

`test/store.test.ts`：残留/损坏/过期外机锁均拒绝且文件仍在；两实验可并行写。`test/candidate-run.test.ts`：attempt 先于 Runtime；unknown 不重发；取消请求先于终态；晚到 settlement 不改码。`test/experiment-activity.test.ts`：旧 operationId 不取消下一操作；CLI 打印三类 ID。反向：自动 `writer.lock_reclaimed` 或 `cancel` 打到下一操作则红。
