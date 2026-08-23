# 决策：Recovery direct write 的 Host-owned attribution

状态：accepted

## 背景

Recovery 可以在隔离 candidate 中通过结构化工具生成文件、移动已有文件或删除文件。仅记录路径和 hash 不能区分“模型通过 Host 工具产生的新内容”和“模型移动/删除了原有内容”；如果报告把模型自述当作来源证明，审查者无法判断归因是否可信。

## 决定

编排层在持久化 `recovery.controlled_write` 事件前，根据 Host 注册的工具身份添加 schema-validated `origin`：

- `write_file`、`write_binary_file`、`write_recovery_manifest`、`write_recovery_report`：`agent_direct_write`；
- `rename_file`：`agent_direct_move`；
- `delete_file`：`agent_direct_delete`。

该字段证明的是“哪个受控 Host 工具完成了哪类操作”，不是证明文件内容正确、任务语义正确或可以自动接受。正文仍由 postimage artifact 的 hash/size 完整性证明和 Provider/verifier 负责；shell、IDE、browser、database 等不可观测写入不进入该 attribution。

底层 Recovery 工具直接使用时可以不带 `origin`，因为它只负责产生原始 journal；只有编排层将 Host-owned 事件写入实验日志时才补充归因。所有带归因的条目继续经过 `RecoveryControlledWriteSchema` 的 `Value.Check`。

## 后果

- 审查摘要和审计重放可区分 generated、move、delete，而不依赖模型文字。
- `agent_direct_write` 不能被解释为 verified recovery；弱证据仍只能进入 pending review/partial 层级。
- 若未来增加非 Agent Host 操作，必须增加独立 origin 枚举并同步更新 schema、反向测试和决策记录，不能复用 `agent_direct_write`。

## 验证

`test/codex-experiment.test.ts` 验证编排生成的成功 direct postimage 具备 `agent_direct_write` attribution；`test/recovery-tools.test.ts` 保持底层工具 journal 的最小 metadata 合同。源码验证应运行 `npm run build`、受影响测试、`npm run verify:docs` 和 `npm run check`。
