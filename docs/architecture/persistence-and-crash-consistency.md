# 持久化与崩溃一致性

状态：当前架构基线

本文定义 Harness 的本地持久化协议、崩溃恢复语义和删除边界。它是 `overview.md` 中 Trace、RunManifest、RunRecord、Artifact 和 Comparison Projection 的专题规范；不改变这些公共对象的所有权。

## 1. 设计目标

第一版不使用数据库。Harness 是个人用户的本地工具，实验数量少，最重要的是事实可追溯、进程崩溃后不误判、候选运行不重复和当前工作区不受破坏。

核心原则是：

> append-only 事件和不可变 artifact 是事实来源；`state.json`、`RunRecord` 和报告是可重建投影。

这不是完整的通用 Event Sourcing 框架，而是一个足够支撑单机实验的文件协议。

## 2. 本地目录

```text
data/
├── cases/<case-id>/
│   ├── case.json
│   ├── case.complete
│   ├── transcript/
│   ├── baseline-artifacts/
│   └── environment/
│       ├── resources.json
│       ├── fingerprint.json
│       └── manifest.json
├── experiments/<experiment-id>/
│   ├── experiment.json
│   ├── experiment.complete
│   ├── events.jsonl              # 本 Experiment 唯一权威事件日志
│   ├── writer.lock               # 仅活动 writer 持有
│   ├── runs/<run-id>/
│   │   ├── attempt.json
│   │   ├── manifest.json         # 准备成功后才存在
│   │   ├── state.json
│   │   ├── artifacts/
│   │   └── record.json
│   └── comparison/
│       ├── projection.json
│       └── report/
└── blobs/<content-hash>
```

`case.json`、`experiment.json`、`attempt.json` 和已存在的 `manifest.json` 是不可变对象。`attempt.json` 在 CandidateRun 创建时提交；`manifest.json` 只在 Runtime、模型和隔离环境均解析成功后提交，准备失败的 run 不伪造半 Manifest。`case.complete` 和 `experiment.complete` 是对应规格的原子提交标记；没有标记的 Case 或 Experiment 不得作为有效输入。`attempt.json` 与可选 `manifest.json` 先原子 rename，再分别以唯一事件 `run.attempt_created`、`run.manifest_created` 提交；文件存在但缺少对应事件时视为未提交残留。`state.json`、`record.json` 和 comparison projection 都可以删除并从事实重建。`blobs/` 可在第一版延后实现；无论 artifact 是否集中存储，都必须保存 hash 和 ownership。

`experiments/<experiment-id>/events.jsonl` 是该 Experiment 的唯一事件事实来源。`readRun(runId)` 过滤这份日志，不在 run 目录双写第二份事件日志。第一版数据量小、候选串行，线性过滤优先于维护崩溃时可能分叉的索引；需要性能时再增加可重建索引。

## 3. 写入规则

### 3.1 不可变快照

规格、manifest 和投影使用：

```text
写入同目录临时文件
→ flush（必要时 fsync）
→ 原子 rename
→ 写入 .complete 或提交事件
```

不得直接覆盖正式 JSON。修改 TaskCase、ExperimentSpec、RunManifest 或 baseline 时创建新对象，不在原文件上编辑。

### 3.2 追加式事件与单写者

Experiment 的 `events.jsonl` 只追加，不更新已有行。每个活动 Experiment 同时最多一个 writer：写者获取 `writer.lock` 后才能分配 sequence、追加事件或刷新投影；其他 CLI 进程只能只读或明确报错，不能自动抢锁。lock 至少记录 PID、process nonce、启动时间和 experiment ID；判断 stale lock 时还必须核查已持久化 operation 与 Runtime 外部状态，不能只凭 PID 不存在就重放副作用。

事件包络为：

```ts
interface EventEnvelope {
  schemaVersion: number;
  sequence: number;
  eventId: string;
  occurredAt: string;
  type: string;
  runId?: string;
  payload: unknown;
  checksum: string;
}
```

sequence 的分配和 append 由同一个 Store 实例在 writer lock 内完成。恢复时允许截断末尾不完整行；中间损坏、checksum 不匹配或 sequence 不连续必须标记 `corrupt`，不能静默跳过。事件写入本身不重新执行外部副作用。

### 3.3 artifact

artifact 先写临时文件，关闭后计算 `contentHash` 和 `byteLength`，再原子 rename；只有 `artifact.created` 已经追加成功后才允许被报告引用。

```ts
interface ArtifactManifest {
  artifactId: string;
  schemaVersion: number;
  kind: string;
  mediaType?: string;
  byteLength: number;
  contentHash: string;
  createdAt: string;
  owner: { caseId?: string; experimentId: string; runId?: string };
  sourceEventId: string;
  path?: string;
  provenance?: ArtifactRef[];
}
```

读取 artifact 时同时校验路径归属、manifest owner、文件存在性和 hash。模型输出中的路径或 artifact ID 一律是不可信输入。

## 4. 运行事实和完成定义

`RunRecord` 是事件重放后的投影，不是唯一真相。它始终引用已提交的 `RunAttempt`；只有准备成功的运行才引用 `RunManifest`。追加终态事件前，必须先持久化以下事实：

1. Runtime 已确认结束，或者无法确认其结束的事实已经作为 termination/cleanup 不确定性持久化；
2. 已经产生的最终消息、trace、telemetry 和必要 artifact 已提交，未产生项明确为 unavailable；
3. after-fingerprint 已提交，或无法采集的原因已记录；
4. cleanup 已完成，或 incomplete/unknown 已记录。

随后追加且仅追加一个与 `RunTermination` 对应的 `run.finished` 事件。只有该事件持久化后，重放结果才可生成终态 `RunRecord`。

`finished` 表示 Harness 已完成所有可安全执行的收尾并固化剩余不确定性，不表示 Runtime、环境和资源一定全部正常。

如果进程在 finalizing 中崩溃而没有终态事件，启动时显示 `interrupted`，不能猜测为成功。Comparison 或 Renderer 失败不改变 CandidateRun 的 outcome。

## 5. 事件协议中的输入提交

Controller 生成输入不等于 Runtime 已接受输入。标准顺序为：

```text
controller.input_proposed
→ input.submission_started
→ input.submitted
→ runtime.input_accepted
```

只有 `runtime.input_accepted` 才推进到候选 turn。目标 CLI 的 Product Pack 负责定义如何确认该边界；Harness 不把进程写入成功或 stdout 出现当作通用判据。

## 6. 崩溃恢复

启动或打开实验时：

```text
校验 Experiment、RunAttempt 与可选 RunManifest 的提交状态
→ 校验并读取唯一 events.jsonl
→ 截断末尾半行
→ 按 sequence 重放
→ 以重放结果为准重建 state/record
→ 校验 artifact 和 fingerprint
→ 原子刷新投影
```

建议的恢复分类：

```ts
type RecoveryStatus =
  | "clean"
  | "resumable"
  | "cleanup_only"
  | "incomplete"
  | "corrupt";
```

`state.json` 损坏可以重建；事件事实损坏必须显式报告。缺失 artifact 不阻止读取事件，但会把 run 标记为 `incomplete`。

## 7. resume、retry 和幂等操作

同一 `runId` 只允许恢复未完成生命周期、补写投影和执行安全 cleanup；不允许用它启动第二条候选轨迹。用户要求重试时创建新 `runId`，引用旧 run 作为前次尝试。

所有可能有副作用的操作使用稳定 `operationId`。operation ID 只提供关联能力，不凭空产生外部系统的幂等性；Product Pack 必须说明每类不确定操作可查询的原生证据以及无法查询时的终止结果：

```ts
interface OperationRef {
  operationId: string;
  kind: "start" | "submit" | "cleanup" | "release" | "artifact_commit";
}
```

恢复前先查询 operation 是否已完成；已完成则复用结果，未知时不得盲目重放。发送输入尤其如此：接受状态未知时结束，不通过普通确认诱导用户承担重复副作用风险。Runtime start、send 和 stop 的可核查能力由各 Product Pack 记录；无法 reconnect、按 client ID 查询或确认进程退出时，必须固化 `uncertain.*` 与 cleanup unknown，而不是宣称 exactly-once。

## 8. schema 版本化

所有持久化对象和事件包络都带 `schemaVersion`。读取支持当前版本和明确支持的旧版本；写出只使用当前版本。迁移写入新临时文件并原子替换，无法迁移时保留原数据并报告 `unsupported_schema`。事件字段只能向后兼容地新增；删除或改变语义必须提升版本。

## 9. 删除和保留

默认删除是软删除或归档，不立即物理删除。显式清理前检查运行状态和引用关系；只删除无其他引用的 artifact。第一版可以没有复杂 GC，但不得让重新生成报告或重试自动删除历史 run、TaskCase 或原始证据。

## 10. 从成熟 Agent 产品借鉴的边界

Pi 的轻量 session 文件、可配置 session 目录、独立 telemetry 和将 sandbox 交给宿主的做法支持本协议的克制设计。[Pi Agent Harness README](https://github.com/earendil-works/pi)

Codex CLI 的 durable user submission queue、resume 时保留线程元数据、权限集中管理、compaction 记录和幂等 shutdown，支持本协议对输入接受、恢复分类和 cleanup 的定义。[Codex CLI changelog](https://learn.chatgpt.com/docs/changelog#month-2026-08)

Claude Code 的独立 CLI 边界允许 Product Pack 负责原生 session、当前 Runtime 发现与协议适配，以及恢复证据解释；这些私有文件格式不进入 Core 协议。[Claude Code repository](https://github.com/anthropics/claude-code)

不照搬任何产品的目录格式、内部状态机或权限默认值；只采纳能提高事实持久性、恢复安全性和边界清晰度的原则。

## 11. 第一版验收条件

- 同一 Experiment 只有一个事件 writer；第二个 CLI 进程不能并发分配 sequence 或追加事件；
- 进程在任意事件写入点退出后，末尾半行可识别且不会被当作事实；
- 删除 `state.json` 和 `record.json` 后，能仅凭 attempt、可选 manifest、唯一 events 和 artifact 重建；
- 同一 `runId` 恢复不会产生第二条候选轨迹；
- 输入接受状态未知时不会自动重复发送；
- artifact 缺失、hash 不匹配和事件损坏在报告中可见；
- Comparison/Renderer 失败不改变已完成的 CandidateRun；
- 当前工作目录从未被候选 Runtime 原地使用；
- schema 不兼容时保留原数据并给出 `unsupported_schema`。

## 12. 事件信封字段

<!-- BEGIN GENERATED event-catalog (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
| 字段 | 类型 | 可选 |
|---|---|---|
| `schemaVersion` | integer | 否 |
| `sequence` | integer | 否 |
| `eventId` | string | 否 |
| `occurredAt` | string | 否 |
| `type` | string | 否 |
| `runId` | string | 是 |
| `operationId` | string | 是 |
| `payload` | unknown | 否 |
| `checksum` | string | 否 |
<!-- END GENERATED event-catalog -->

## 13. 明确不做

- SQLite 或通用事件溯源框架；
- 分布式消息队列和工作流引擎；
- 自动回滚外部数据库、远程服务或真实凭据；
- 将 telemetry 作为运行成功的前提；
- 将任一 Agent 产品的私有 session 文件格式提升为核心协议。
