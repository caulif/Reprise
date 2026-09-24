# 证据、持久化与 Comparison

## 事件日志与文件

每个 Experiment 目录由 [`ExperimentStore`](../../src/infrastructure/store/experiment-store.ts) 管理：`events.jsonl` 追加事件，`writer.lock` 保证单写者，`runs/<runId>/attempt.json` 和 `manifest.json` 通过 `writeImmutableJson` 保存不可变快照，artifacts 旁有 manifest。Store 重开时会读取并校验事件；只读打开不改日志，取得 writer 锁后才按字节截掉不完整尾行，保留完整事件的原始字节。这提供 replay 能力，不等于应用启动会自动安全续跑未完成实验。

事件有 sequence、eventId、type、可选 runId/operationId、payload、occurredAt 和 checksum。提交请求入队时先取得与 JSONL 一致的 JSON 快照，追加前总是校验 `EventEnvelopeSchema`；对 Controller、Comparison、候选用户可见 turn 等已登记事件再校验专用 payload schema，未登记 type 不会获得额外的通用 payload 结构校验。Store 持有的已提交事件深度冻结，追加返回值、订阅参数和 `events` / `eventsSince` 的元素都不能改写日志事实；读端只复制结果数组，不重复深复制全量 payload。重复 operation 在相同 type/run/payload 时幂等，不同数据会失败。去重范围仍是整个 Experiment；run 所属操作由各自写入者从 runId 与局部 ID 派生独立、有界的 operationId，旧事件原样重放，见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

持久化边界使用 `Value.Check`：RunAttempt 必须先于 RunManifest；模型输出、外部 JSON、artifact manifest 和比较 briefing 经过对应 schema。Artifact manifest 的 schema 位于 core；Store 读取时校验版本、owner、ID 与路径，读取正文和幂等重试还校验长度/hash。成功 artifact 必须有与 `sourceEventId` 对应且归属匹配的 `artifact.created`；同内容但缺事件的残留也拒绝自动补提交，不覆盖原文件。并发 artifact 提交由 Store 串行处理。细节见[Artifact 提交事实与磁盘内容一致](../decisions/accepted/2026-09-23-artifact-commit-integrity.md)。实验没有生产 `experiment.complete` 标记；有效性由实际 spec、attempt、manifest、日志和读端规则决定，不应虚构该文件。

Recovery 的固定 artifact 与决定、诊断等不可变 JSON 按 `runs/<runId>/` 保存；默认 Recovery Provider 的 baseline 按 `environment/recovery/<runId>/` 隔离。baseline marker 的 `reportRunId` 指向 run 所属报告，旧 marker 缺字段时只查实验级报告；旧 scene 缺 `recoveryProviderRunId` 时继续使用 `environment/baselines/`。旧根级文件不迁移、不覆写，新读端按明确 owner 读取，不能用另一 run 的同名 artifact 填补缺失。

## 模型输入可追溯

Controller、Recovery、Comparison 都通过 Agent Session Host 生成模型请求。Host 把 system prompt、用户消息、工具结果和结构化结果写入审计事实；[`model-input.ts`](../../src/infrastructure/agent/model-input.ts) 从事件日志重建请求。上下文压缩必须追加 `agent.context_compacted`，其中 summary 与 retained tail 是后续请求可见的输入来源。新增模型可见事实必须先写入事件审计（必要时再由 briefing 做可读投影），不能只存在内存变量。

TUI 读取这些事实并投影状态。它不持有 CandidateRun 状态机，不展示未公开的内部推理，也不把模型输出未经 schema 校验地当成事实。

## Comparison attempt

候选 RunRecord 完成后，Comparison 可由 TUI 或 CLI 显式启动，默认跳过。每次生成创建独立 `comparison-attempts/<attemptId>/`，写入 `INDEX.md`、冻结的 `observations/`、候选快照状态、facts JSON、证据短引用、媒体清单和工作区。历史会话与候选事件以只读快照挂载；`history/` 提供历史过程，`finals/`（shell：`REPRISE_FINALS_ROOT`）提供本 attempt 冻结或派生的历史终稿。Comparison Session 不运行 Runtime、不修改 CandidateRun outcome。

Attempt 作用域持有可修订的证据 catalog：权威 revision 落在 `facts/evidence-catalog/rev-N.json`，`CURRENT` 在 facts 镜像写完后原子切换；`briefing/facts/` 与 `facts/` 的 `media.json` / `evidence-index.json` 由同一 revision 派生。短引用 `ev-*` / `media-*` 为 2–6 位数字，append-only，不复用已分配编号。调查中可通过 `register_evidence` 追加派生分析（Host 强制 `origin=derived_analysis`）；成功注册写入 `comparison.evidence_registered`（attemptId、revision、source refs、content hash、artifact refs；不含 base64 或私人绝对路径）。mutate/persist 后若 emit 失败，同内容重试必须补发事件。`render_artifact` / `preview_report` 为 Host 受控预览入口（`experiment-report.ts` 挂载真实工厂；`sourceRef` 仅映射到冻结 `finals/`/受控 `history/` 或 candidate snapshot）。媒体记录可带 `sourceRef` / `contentHash` / `derivation`；seed/briefing 物化时对可用图片文件写入与原生交付同口径的 `contentHash`（文件字节 sha256）。`available=true` 本身不构成向模型发送图片的授权；另需 privacy/发送策略与模型 `inputCapabilities`。报告中的裸 `<img data-media-ref>` 可供人阅读；`data-claim="visual"` 还须对应媒体的 `contentHash` 出现在本 Comparison Session 实际交付的原生图片集合中（text-only 剥离后该集合为空，不得自称看过）。

Host 拥有 header、metrics、cost-note、evidence、process 和页面样式。Agent 只写 `work/report/content.json`、`body.html` 与可选 `details.html`；Host 按本 attempt 的事实重建整页。`content.json` 版本 1 含 headline、criticalLimitations 与 evidenceRefs。正文可自主选用图、表、片段或步骤；无图不强制空视觉段，单侧结果须就近说明缺失方。Host 拒绝可执行标签、SVG/MathML、事件属性和危险 URL；引用的图片与证据必须在当前 catalog 登记且文件可读，派生证据发布时校验字节 hash。整页再经过 schema、HTML、引用、模型已见图片和外部资源检查。展示问题由 Host 确定性修复，无法修复时记录限制；Agent 的自然语言不能覆盖确定性事实。新合同见[Comparison 内容文件、受管调查工具与预览收据](../decisions/accepted/2026-09-24-comparison-content-and-tools.md)；旧四区模型与整页创作入口已移除，历史决定见[自主任务比较报告区与安全发布](../decisions/accepted/2026-09-19-comparison-autonomous-report-zones.md)及[Host 重建报告](../decisions/accepted/2026-09-23-host-rebuilt-comparison-report.md)。

Agent 区的内联 `style` 属性和原生 `dialog` / popover 浮层一律拒绝，避免遮盖 Host 的任务、模型与指标。

## 报告发布

正式报告是 experiment 根部的 `report.html` 及其媒体、被引用的派生证据。预览使用同一校验器生成 digest 收据；最终内容、事实、catalog revision 或媒体交付变化后必须重新预览。发布前关闭受管进程与浏览器；`publishComparisonArtifacts` 校验并复制图片和派生证据，写当前 formatVersion 2 的审计 `report-model.json`，最后原子替换根 `report.html`。缺版本、格式 1 或旧四区槽位的模型不再读取，也不自动迁移；原有历史文件不删除。失败或取消不得覆盖旧成功报告仍引用的资产。

Comparison 是运行后的可选证据视图，不是新的实验状态机，也不为历史 Runtime 版本提供精确复现保证。报告失败不应改写 CandidateRun 的 outcome；失败诊断保留原任务和草稿排查路径，未经发布校验的草稿正文不能作为正式结论。报告中应明确 baseline、candidate、证据缺口和 cleanup 状态。

## 文件与兼容边界

TaskCase 通过 case.complete 发布，缺少标记的半成品不能作为完整场景。可选历史终稿封存在 `baseline-artifacts/manifest.json` 与配对的 `baseline-artifacts/files/<bundleId>/…`；旧 Case 无清单时由 attempt `derived-history/` 补证，不写回已发布 Case。Experiment 使用自身的日志与文件协议，不能套用 Case 标记。只读 History 不申请 writer 锁、不改写日志；未知 schema 和完整坏行需要诊断，不能跳过坏行拼出完整轨迹。持久化 compare 与历史摘要依赖 record.json；Store 能 replay 不证明记录文件丢失时应用会自动重建。

进入模型的正文先经过秘密过滤，再持久化并发送；超出内联预算的内容使用带 hash/长度的附件，重建时校验。Pi 内存 transcript 不是另一份持久化真相。角色工具读取的正文同样需要可复原的事件／附件记录，仅保存可变文件路径或 digest 不足以重建输入。

Comparison 每次使用独立 attempt 和连续 Session，按理解、调查、创作、审阅推进。可执行 Prompt 以 [`comparison-agent.ts`](../../src/agents/comparison-agent.ts) 为唯一文本源：以任务成功标准选证据形式，使用受管 `browser_*`、`render_artifact`、`register_evidence`、`preview_report` 等工具；禁止经 `shell_exec` 启动 Chrome/Edge/Firefox、读取用户 profile 或以等价浏览器 shell 重试。Host 在进入 compose 前拒绝已出现的报告内容；file tools 在理解/调查阶段只写工作笔记，在创作/审阅阶段才写报告内容。Agent 审阅实际预览且改稿后重检；创作与审阅共用一次内容修复额度。信封短引用取自当前 catalog，未知引用进入有限 JSON repair，不得静默丢弃。Host 持有确定性指标和模板区域；未知 token、价格或用量不是零。候选 snapshot 缺失或不完整时明确 unavailable，不能悄悄改读可变运行副本。

Host 对 HTML/SVG 终稿做受控无头渲染（`infrastructure/artifact-renderer.ts`：127.0.0.1 bundle 服务 + CDP；raster 直接拷贝），经 `headless-screenshot.ts` 委托。双侧有视觉交付但缺可用配对截图时，briefing 写入 `facts/visual-limitations.json` 并保留来源；缺浏览器不是整个 Comparison 的终止条件。`render_artifact` 与受管浏览器观察登记来源、版本、动作和截图；模型可见 URL 省略 query/hash。`preview_report` 与发布共用可发布 HTML 校验；预览图属 host review（独立 `review-*` 短引用），不进入比较证据 allowlist。能力检测写入 `facts/capabilities.json`；检测到可选程序不等于已具备受控转换工具。详情见[新合同](../decisions/accepted/2026-09-24-comparison-content-and-tools.md)、[受控产物渲染与报告预览](../decisions/accepted/2026-09-19-controlled-artifact-render.md)、[attempt 装配](../../src/application/comparison.ts)和[发布](../../src/application/comparison-publication.ts)。

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

