# 决策：Artifact 提交事实与磁盘内容一致

状态：accepted

## 问题

`ExperimentStore` 曾在 artifact payload 文件存在时直接返回旁边的 manifest，未核验其版本、身份、内容或 `artifact.created` 事件。相同 ID 的不同内容可能被当成成功重试；事件追加失败后留下的文件也可能被误认作已提交。并发提交还可能覆盖同一文件。

## 决定

- Artifact manifest 的单一 schema 位于 `src/core/schemas/artifact.ts`，经 `src/core/schema.ts` 导出。读盘时校验 schema、版本 1、owner、artifactId 和相对于 Experiment 根的路径；记录路径只在比较时统一斜杠，不迁移旧 v1 文件。
- `artifact.created` 的 `eventId` 必须等于 manifest 的 `sourceEventId`，且事件的 runId 与 payload artifactId 必须匹配。读取、列举和幂等重试均须满足该提交事实。读取和重试还核验正文长度及 hash。
- 同 owner/ID 的重试只有在 kind、mediaType、长度、hash 与实际文件一致时成功。任一文件缺失、manifest 损坏、正文损坏、事件缺失或身份冲突时拒绝，并保留原始文件。即使内容相同，缺少 `artifact.created` 的残留也不自动补写事件；旧事件存在但文件缺失时不重建文件。
- 同一 Store 上的 artifact 提交串行处理；调用时复制输入 bytes，`close` 等待已接收的提交。此队列独立于事件追加队列，提交内部可以安全追加事件。
- Artifact 正文可使用 `.json` 后缀。列举时按 payload 与相邻 `.json` manifest 的文件对识别，不能把 JSON 正文当 manifest，也不能静默跳过不完整或损坏的文件对。

## 备选方案

**自动补发残留事件。** 文件可能来自失败或外部篡改，单凭其存在无法确定原提交意图；自动补发会把未证实的事实写入日志。

**覆盖冲突文件以完成重试。** 会破坏不可变证据，也无法保证旧事件的 sourceEventId 仍指向原内容。

## 影响

旧的有效 v1 artifact 保持可读、可幂等重试。损坏或未提交残留需要人工诊断，不会因一次重试被改写。事实层见[证据、持久化与 Comparison](../../architecture/evidence-and-comparison.md)。

## 验证

`test/core/store.test.ts` 覆盖有效重试、内容与元数据冲突、JSON 后缀正文、无效版本和身份、缺事件残留、旧事件缺文件、并发提交及输入 bytes 所有权。
