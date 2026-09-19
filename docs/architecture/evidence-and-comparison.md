# 证据、持久化与 Comparison

## 事件日志与文件

每个 Experiment 目录由 [`ExperimentStore`](../../src/infrastructure/store/experiment-store.ts) 管理：`events.jsonl` 追加事件，`writer.lock` 保证单写者，`runs/<runId>/attempt.json` 和 `manifest.json` 通过 `writeImmutableJson` 保存不可变快照，artifacts 旁有 manifest。Store 重开时会读取并校验事件、修复可丢弃的不完整尾部；这提供 replay 能力，不等于应用启动会自动安全续跑未完成实验。

事件有 sequence、eventId、type、可选 runId/operationId、payload、occurredAt 和 checksum。追加前总是校验 `EventEnvelopeSchema`；对 Controller、Comparison、候选用户可见 turn 等已登记事件再校验专用 payload schema，未登记 type 不会获得额外的通用 payload 结构校验。重复 operation 在相同 type/run/payload 时幂等，不同数据会失败。当前 operation 去重范围是整个 Experiment，run-owned 固定 ID 因此可能产生跨 run 冲突。

持久化边界使用 `Value.Check`：RunAttempt 必须先于 RunManifest；模型输出、外部 JSON、artifact manifest 和比较 briefing 经过对应 schema。实验没有生产 `experiment.complete` 标记；有效性由实际 spec、attempt、manifest、日志和读端规则决定，不应虚构该文件。

## 模型输入可追溯

Controller、Recovery、Comparison 都通过 Agent Session Host 生成模型请求。Host 把 system prompt、用户消息、工具结果和结构化结果写入审计事实；[`model-input.ts`](../../src/infrastructure/agent/model-input.ts) 从事件日志重建请求。上下文压缩必须追加 `agent.context_compacted`，其中 summary 与 retained tail 是后续请求可见的输入来源。新增模型可见事实必须先写入事件审计（必要时再由 briefing 做可读投影），不能只存在内存变量。

TUI 读取这些事实并投影状态。它不持有 CandidateRun 状态机，不展示未公开的内部推理，也不把模型输出未经 schema 校验地当成事实。

## Comparison attempt

候选 RunRecord 完成后，Comparison 可由 TUI 或 CLI 显式启动，默认跳过。每次生成创建独立 `comparison-attempts/<attemptId>/`，写入 `INDEX.md`、冻结的 `observations/`、候选快照状态、facts JSON、证据短引用、媒体清单和工作区。历史会话与候选事件以只读快照挂载；Comparison Session 不运行 Runtime、不修改 CandidateRun outcome。

Attempt 作用域持有可修订的证据 catalog：权威 revision 落在 `facts/evidence-catalog/rev-N.json`，`CURRENT` 在 facts 镜像写完后原子切换；`briefing/facts/` 与 `facts/` 的 `media.json` / `evidence-index.json` 由同一 revision 派生。短引用 `ev-*` / `media-*` 为 2–6 位数字，append-only，不复用已分配编号。调查中可通过 `register_evidence` 追加派生分析（Host 强制 `origin=derived_analysis`）；成功注册写入 `comparison.evidence_registered`（attemptId、revision、source refs、content hash、artifact refs；不含 base64 或私人绝对路径）。mutate/persist 后若 emit 失败，同内容重试必须补发事件。`render_artifact` / `preview_report` 为受控预览入口（渲染实现另包）。媒体记录可带 `sourceRef` / `contentHash` / `derivation`。`available=true` 本身不构成向模型发送图片的授权；另需 privacy/发送策略与模型 `inputCapabilities`。

Host 预置 HTML 模板并拥有 header、metrics、cost-note、evidence、process 等区域；新报告 `data-report-format="2"` 的 Agent 区为 `comparison`（主创作）与可选 `details`（可见 `<details>`）。Agent 在 `comparison` 内自主选择并排图、表格、短片段或步骤；无图时不强制空视觉段；单侧真实结果可保留但须就近写明缺失方。输出经过 schema、HTML 契约和 evidence/media 引用检查。契约失败拒绝发布；展示问题由 Host 确定性修复，无法修复时记录 limitations 并仍可发布，不能把所有样式问题提升为失败门禁。Agent 的自然语言判断不能覆盖确定性事实，证据缺失必须明确说明，不得伪造引用。版式与发布取舍见[自主任务比较报告区与安全发布](../decisions/accepted/2026-09-19-comparison-autonomous-report-zones.md)。

## 报告发布

正式报告是 experiment 根部的 `report.html` 及其媒体。`publishComparisonArtifacts` 先把被引用媒体拷到内容寻址路径（`media/<hash>.…`）并校验，再写审计 `report-model.json`（含 `formatVersion: 2` 与 `comparison` / `details` slots；旧四区 model 仍可读），最后原子替换根 `report.html`。失败或取消不得覆盖旧成功报告仍引用的资产。

Comparison 是运行后的可选证据视图，不是新的实验状态机，也不为历史 Runtime 版本提供精确复现保证。报告失败不应改写 CandidateRun 的 outcome；报告中应明确 baseline、candidate、证据缺口和 cleanup 状态。

## 文件与兼容边界

TaskCase 通过 case.complete 发布，缺少标记的半成品不能作为完整场景。Experiment 使用自身的日志与文件协议，不能套用 Case 标记。只读 History 不申请 writer 锁、不改写日志；未知 schema 和完整坏行需要诊断，不能跳过坏行拼出完整轨迹。持久化 compare 与历史摘要依赖 record.json；Store 能 replay 不证明记录文件丢失时应用会自动重建。

进入模型的正文先经过秘密过滤，再持久化并发送；超出内联预算的内容使用带 hash/长度的附件，重建时校验。Pi 内存 transcript 不是另一份持久化真相。角色工具读取的正文同样需要可复原的事件／附件记录，仅保存可变文件路径或 digest 不足以重建输入。

Comparison 每次使用独立 attempt 和连续 Session，按理解、调查、创作、审阅推进。可执行 Prompt 以 [`comparison-agent.ts`](../../src/agents/comparison-agent.ts) 为唯一文本源：以任务成功标准选证据形式，点名 `render_artifact` / `register_evidence` / `preview_report`；compose 创作 `comparison` 与可选 `details`；review 须预览且改稿后重检。信封短引用取自当前 catalog（`compare` 的 `getEvidenceCatalog`），未知引用进入有限 JSON repair，不得静默丢弃。取舍见[自主 Prompt 闭环](../decisions/accepted/2026-09-19-comparison-autonomous-prompt-loop.md)。Host 持有确定性指标和模板区域，Agent 写本次任务的差异与判断；未知 token、价格或用量不是零。候选 snapshot 缺失或不完整时明确 unavailable，不能悄悄改读可变运行副本。详情见 [attempt 装配](../../src/application/comparison.ts)、[发布](../../src/application/comparison-publication.ts)及[持久化比较入口](../../src/application/experiment-compare-persisted.ts)。

## 事件信封字段

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

