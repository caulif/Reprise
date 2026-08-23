# 决策：Recovery 受控写入的前后哈希 journal

状态：accepted

## 背景

Recovery Agent 能经由结构化工具改写隔离 candidate。若 Agent 中途失败，只观察最终文件树无法区分写前、写后和写入失败，也无法为审查或后续 checkpoint 恢复提供可验证增量。

## 决定

以下 direct Host-controlled 工具统一通过 journal helper 执行：`write_file`、`write_binary_file`、`rename_file`、`delete_file`、`write_recovery_manifest`、`write_recovery_report`。每次操作在写前追加 `before`，成功后追加 `after`，失败追加 `failed`；删除成功后的文件必须缺失，因此 delete 不伪造 `after` 内容。

- `write_binary_file` 接受 canonical 标准 Base64，磁盘内容按原始 bytes 写入；journal 只保存大小和 SHA-256，不保存二进制正文。
- `rename_file` 使用 `sourcePath` 和目标 `path` 形成 paired delta：before 描述源文件，after 描述目标文件；目标不得已存在，成功后源文件必须消失。源/目标均经过 staging path boundary 和 symlink 检查。
- generated 文件目前可以通过 `write_file` / `write_binary_file` 受控生成，但该 journal 本身不声称完成了 generated attribution；其来源仍需 checkpoint、候选证据和 verifier 共同证明。

所有条目先经 `RecoveryControlledWriteSchema` 的 `Value.Check`，再由 Host 写入 `recovery.controlled_write` 事件。条目不保存绝对路径、命令行、任务内容、文件正文或凭据。

`staging_shell` 仍允许在隔离 candidate 内运行，但任意子进程写入无法被 Host 逐写拦截，仍明确标为 external/unobserved writer；最终差异必须由 candidate fingerprint、manifest、Provider verifier 或人工审查处理，不将 shell 写入伪报为 direct journal。

## 重放与后果

Host 提供 `replayControlledRecoveryDelta` 将有序 direct journal 折叠为每个路径的最后已观测 hash/size 状态；不完整操作、无 before 的 after 和重复 before 都会拒绝。该函数只重放元数据，不伪造文件正文，也不覆盖 `staging_shell` 的不可观测写入。真实字节恢复仍必须使用 Provider checkpoint 或其他可验证 artifact。

可观测 direct sink 写入可从事件日志重建前后哈希 delta；rename、binary 和 delete 的语义不再依赖文本文件假设。未观测 shell/IDE/外部副作用仍需更强 checkpoint、workspace diff 或人工审查。未来添加 Recovery 写工具时必须复用 journal helper，或明确标注不可观测性并更新此决策。

## 验证

`test/recovery-tools.test.ts` 覆盖文本、binary、rename、delete 的字节/前后哈希、路径边界和拒绝覆盖；`test/codex-experiment.test.ts` 覆盖 direct sink 事件按顺序可审计。源码验证应运行 `npm run build`、Recovery 定向测试、快照测试、`npm run verify:docs` 和 `npm run check`。
