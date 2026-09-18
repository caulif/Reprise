# 决策：Recovery 受控写入的 content-addressed postimage artifact

状态：accepted

## 背景

受控写入 journal 原先只有 before/after 的大小和 SHA-256。它能够证明某个字节序列被观察到，但不能独立提供写后的文件正文；因此 Host 无法仅依靠事件日志和 artifact 重建 direct Recovery sink 产生的小型文本、二进制和重命名结果。

把文件正文直接放入事件会放大事件日志、泄露风险和重放成本。现有 `ExperimentStore` 已提供 immutable artifact、owner 校验及字节长度/SHA-256 完整性检查，无需另建 blob 存储。

## 决定

`RecoveryControlledWriteSchema` 的文件快照允许包含可选 `artifactId`。底层工具仍只产生路径、大小、hash 和操作阶段；它们不读取或持久化文件正文到事件。

Recovery 编排在每个 direct write 的成功 `after` 回调中：

1. 重新在候选根内解析目标路径，拒绝任何越界路径；
2. 读取该 regular file，并再次核对 journal 的大小和 SHA-256；
3. 以 `recovery-blob-<sha256>` 作为 content-addressed `artifactId` 写入 `ExperimentStore`；
4. 只有 artifact manifest 的大小和 hash 同样匹配时，才将 `artifactId` 追加到 `recovery.controlled_write` 的 `after` 快照。

事件只引用 artifact ID，不含文件字节。相同内容在同一 experiment 中复用同一 immutable artifact。读取 artifact 时仍必须使用 store 的 owner 与完整性校验。

`before` 快照、成功 delete 的缺失状态、失败操作以及 `staging_shell` 不会获得 postimage blob；它们不得被当作可机械恢复的正文证据。Provider checkpoint 与独立 verifier 仍负责任务开始基线和完整树恢复。

## 后果

- direct `write_file`、`write_binary_file`、受控 report/manifest 和 rename 的成功目标具备可审计、可读取的字节证据；二进制内容不再只能依靠哈希猜测。
- 若候选文件在 journal 与 artifact 捕获之间被并发改写，hash/size 复核失败并使 Recovery 安全失败，而不是记录错误 blob。
- `replayControlledRecoveryDelta` 继续只折叠 journal 状态；后续字节级 replay 必须显式解析 artifact refs、验证 owner/hash，并拒绝缺失 blob，不能以 metadata 补造内容。
- 此改动不覆盖 shell、IDE、browser、database 或 remote API 等未观测写入，也不将 `partial` 自动升级为 `verified`。

## 验证

`test/codex-experiment.test.ts` 验证每个成功 direct postimage 都含 hash-addressed artifact ref，且 artifact 字节长度与 SHA-256 等于事件记录；`test/recovery-tools.test.ts` 保持底层 journal 不含正文的约束。源码验证应运行 `npm run build`、这些定向测试、`npm run verify:docs` 和 `npm run check`。
