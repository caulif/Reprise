# 证据、持久化与 Comparison

## 事件日志与文件

每个 Experiment 目录由 [`ExperimentStore`](../../src/infrastructure/store/experiment-store.ts) 管理：`events.jsonl` 追加事件，`writer.lock` 保证单写者，`runs/<runId>/attempt.json` 和 `manifest.json` 通过 `writeImmutableJson` 保存不可变快照，artifacts 旁有 manifest。Store 重开时会读取并校验事件；只读打开不改日志，取得 writer 锁后才按字节截掉不完整尾行，保留完整事件的原始字节。这提供 replay 能力，不等于应用启动会自动安全续跑未完成实验。

事件有 sequence、eventId、type、可选 runId/operationId、payload、occurredAt 和 checksum。提交请求入队时先取得与 JSONL 一致的 JSON 快照，追加前总是校验 `EventEnvelopeSchema`；对 Controller、Comparison、候选用户可见 turn 等已登记事件再校验专用 payload schema，未登记 type 不会获得额外的通用 payload 结构校验。Store 持有的已提交事件深度冻结，追加返回值、订阅参数和 `events` / `eventsSince` 的元素都不能改写日志事实；读端只复制结果数组，不重复深复制全量 payload。重复 operation 在相同 type/run/payload 时幂等，不同数据会失败。去重范围仍是整个 Experiment；run 所属操作由各自写入者从 runId 与局部 ID 派生独立、有界的 operationId，旧事件原样重放，见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

持久化边界使用 `Value.Check`：RunAttempt 必须先于 RunManifest；模型输出、外部 JSON、artifact manifest 和比较 briefing 经过对应 schema。Artifact manifest 的 schema 位于 core；Store 读取时校验版本、owner、ID 与路径，读取正文和幂等重试还校验长度/hash。成功 artifact 必须有与 `sourceEventId` 对应且归属匹配的 `artifact.created`；同内容但缺事件的残留也拒绝自动补提交，不覆盖原文件。并发 artifact 提交由 Store 串行处理。细节见[Artifact 提交事实与磁盘内容一致](../decisions/accepted/2026-09-23-artifact-commit-integrity.md)。实验没有生产 `experiment.complete` 标记；有效性由实际 spec、attempt、manifest、日志和读端规则决定，不应虚构该文件。

Recovery 的固定 artifact 与决定、诊断等不可变 JSON 按 `runs/<runId>/` 保存；默认 Recovery Provider 的 baseline 按 `environment/recovery/<runId>/` 隔离。baseline marker 的 `reportRunId` 指向 run 所属报告，旧 marker 缺字段时只查实验级报告；旧 scene 缺 `recoveryProviderRunId` 时继续使用 `environment/baselines/`。旧根级文件不迁移、不覆写，新读端按明确 owner 读取，不能用另一 run 的同名 artifact 填补缺失。

## 模型输入可追溯

Controller、Recovery、Comparison 都通过 Agent Session Host 生成模型请求。Host 把 system prompt、用户消息、工具结果和结构化结果写入审计事实；普通 generation 另保存 Pi 转换与裁剪后、经过凭据脱敏的实际上下文快照，保留原生工具参数及 SDK 拒绝消息；[`model-input.ts`](../../src/infrastructure/agent/model-input.ts) 从事件日志重建请求。上下文压缩必须追加 `agent.context_compacted`，其中 summary 与 retained tail 是后续请求可见的输入来源。新增模型可见事实必须先写入事件审计（必要时再由 briefing 做可读投影），不能只存在内存变量。

压缩请求另在 `agent.model_request` 的 `compactionInput: AgentTextBody` 保存实际上下文，仅含 systemPrompt、messages 与 tools；经同一秘密过滤的上下文用于审计和发送，不保存 Provider 凭据或只留不可重建的 digest。大正文沿用附件溢出、字节长度与 hash 校验，图片记录为不可变附件引用，不把 base64 写入日志。History 重建可返回独立的 `compactionRequests`，不将压缩混入普通生成请求；历史缺输入体标记 contentComplete=false，附件缺失、损坏或图片校验失败保留不完整与诊断，不把压缩后的 summary 当作压缩请求原始输入。

generation 快照沿用版本化正文、不可变附件、字节长度/hash、图片引用及 schema 校验。重建明确区分快照与旧事件投影；旧日志的 `contentComplete` 只表示已记录正文和图片可读取，不能证明完整上游输入。新独立复审的 live 发布与离线恢复只依据实际 generation 快照核对完整当前 inspection；仅有旧投影与 digest 不足以认证。Provider 配置和认证凭据不属于快照，原始请求 digest 也不等于脱敏/图片引用快照的字节哈希。

TUI 读取这些事实并投影状态。它不持有 CandidateRun 状态机，不展示未公开的内部推理，也不把模型输出未经 schema 校验地当成事实。

History 从已校验的提交日志前缀构造只读附件读取器，每个 Session 按起始事件的 runId 绑定正文和图片读取范围；复用 Store 的 manifest、owner、提交事件及字节/hash 校验。完整图片记录不标成内容缺失，缺失或损坏附件保留诊断并标记输入不完整。此路径不创建目录、取得 writer lock 或改写未提交尾部。

## Comparison attempt

严格三会话路径向模型提供单一 schema 的 `update_comparison_findings_delta`，delta 的 `addedFindings` / `addedQuestions` 可新增观察或问题；已有每个 ID 仍须完整且恰好一次 retain/replace，新增不能覆盖旧身份。Host 根据真实当前记录合成 canonical submission，继续经过原 `Value.Check`、来源及 catalog/findings 绑定校验，不补造语义内容。完整工具保留兼容，两个名称在全部阶段、完成回调和副作用入口服从相同守卫。

正常调查和独立来源审查每6次来源工具后在完整 turn 边界进入只准保存的窗口，禁止读取、渲染、登记和其他副作用。只有真实 accepted 且当前实际非空 saved state 匹配才可继续；pending 保存可回到下一来源批次，不能冒充 ready，ready 才可结束该调查。每个阶段最多5窗口，Session、累计资源和绝对截止不重置：调查仍共享120秒，独立来源初查及保存仍共享110秒并受审阅总截止限制。下述 `independent_findings_pending` 指来源完成边界，窗口内 accepted pending 本身不立即结束来源阶段。旧端口保持兼容，有限收尾、稿件失效和实际核稿/inspection/preview要求不放宽。见[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

SDK 参数校验拒绝可能发生在 Host 应用工具入口前，仍通过既有安全 called/failed 工具事件计数；新审计只记录工具身份与拒绝类别，不复制整份无效参数或 SDK 回执。模型可见拒绝继续由脱敏 generation 快照复原。拒绝不代表应用工具执行成功；审计失败保持 fatal。增量保存及有界窗口不构成实际模型性能或稳定性验收。

新草稿生产调查通过同进程 `hasSavedFindings` 读取 discovery 的真实接受状态。首次 snapshot 接受前，调查执行边界拒绝 shell/render/register，read 与导航按原预算开放，模型须先保存最小完整的任务标准、双侧 final（未知可 unavailable）、空或实际 findings、pending 问题与 nextCheck；非法更新与口头承诺不能解锁。接受仅解除首次检查点，pending 与旧 catalog 仍不能 compose；重要检查后提示要求完整替换并保留问题历史，不新增独立阶段、不重复扩大工具结果。closure 与独立 source pass 按后述严格路径共享阶段截止或旧端口兼容规则推进，整体硬保护和取消先检查，旧无 getter 端口保持兼容。见[首次 findings 检查点](../decisions/accepted/2026-10-05-comparison-first-findings-checkpoint.md)。

Session 以有效 Provider 冻结身份、API、输入能力、声明来源与无凭据配置指纹，Session 声明冲突则取消。图片工具结果、压缩 retained tail 和最终 `agent.model_request.images` 保存不可变附件的 hash、长度与 artifactId，不存 base64。最终清单反映 Pi 转换后的实际图片；视觉声明和离线恢复优先依据这些实际清单，只有无清单的历史日志沿用旧交付事实。重建校验附件，无附件或二进制 resolver 时标记不完整，读取失败与 hash 错误有诊断。文本裁剪保留最近 12 个原生图片块，旧图片换成 hash 与重新读取提示。

`render_artifact` / `preview_report` 的可选 `includeImages=true` 交付受控 PNG；默认仍返回文本引用。二进制权限来自 Case `privacy.allowBinary`，再由模型能力过滤，媒体存在不等于授权。附图检查登记路径的真实 attempt 边界、hash、PNG 头部尺寸与预算（4 张、单张 3 MiB、总 8 MiB、单张 9,216,000 像素），不交付部分失败的集合，缓存同样检查。头部验证不是完整解码。`imageDelivery` 区分 attached、not_authorized、unsupported_model、unavailable 和 budget_exceeded。

review 改稿回执保持当前阶段，相同 digest/revision 的幂等提交保留预览，不同版本失效。严格三会话路径最多一次同 Session 核稿修复；其他旧端口保留最多两次追加审阅，无进展则退出。当前版本成功预览、真实核稿与当前完整 inspection 进入后续 generation、未取消等发布边界保持有效，见[原生图片链路与版本续审](../decisions/accepted/2026-09-30-comparison-native-image-pipeline.md)及[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

候选 RunRecord 完成后，Comparison 可由 TUI 或 CLI 显式启动，默认跳过。每次生成创建独立 `comparison-attempts/<attemptId>/`，写入 `INDEX.md`、冻结的 `observations/`、候选快照状态、facts JSON、证据短引用、媒体清单和工作区。历史会话与候选事件以只读快照挂载；`history/` 提供历史过程，`finals/`（shell：`REPRISE_FINALS_ROOT`）提供本 attempt 冻结或派生的历史终稿。Comparison Session 不运行 Runtime、不修改 CandidateRun outcome。

Briefing 另写有界的 `decision-map.md`：从冻结证据索引、可打开终稿发现结果、媒体状态与候选 snapshot 状态列出双侧交付线索和待核缺口。它只帮助定位，不确认最终版本或给出质量判断；原始索引与文件仍是核查依据。理解轮优先读取该入口，工具读取正文继续进入模型输入审计。取舍见[交付导航与预览复用](../decisions/accepted/2026-09-25-comparison-navigation-and-preview-cache.md)。

Attempt 作用域持有可修订的证据 catalog：权威 revision 落在 `facts/evidence-catalog/rev-N.json`，`CURRENT` 在 facts 镜像写完后原子切换；`briefing/facts/` 与 `facts/` 的 `media.json` / `evidence-index.json` 由同一 revision 派生。短引用 `ev-*` / `media-*` 为 2–6 位数字，append-only，不复用已分配编号。调查中可通过 `register_evidence` 追加派生分析（Host 强制 `origin=derived_analysis`）；成功注册写入 `comparison.evidence_registered`（attemptId、revision、source refs、content hash、artifact refs；不含 base64 或私人绝对路径）。mutate/persist 后若 emit 失败，同内容重试必须补发事件。`render_artifact` / `preview_report` 为 Host 受控预览入口（`experiment-report.ts` 挂载真实工厂；`sourceRef` 仅映射到冻结 `finals/`/受控 `history/` 或 candidate snapshot）。媒体记录可带 `sourceRef` / `contentHash` / `derivation`；seed/briefing 物化时对可用图片文件写入与原生交付同口径的 `contentHash`（文件字节 sha256）。`available=true` 本身不构成向模型发送图片的授权；另需 privacy/发送策略与模型 `inputCapabilities`。报告中的裸 `<img data-media-ref>` 可供人阅读；`data-claim="visual"` 还须对应媒体的 `contentHash` 出现在本 Comparison Session 实际交付的原生图片集合中（text-only 剥离后该集合为空，不得自称看过）。

普通正文中的“视觉检查”等自然语言不由 Host 词表解释为已看图主张：否定、引述、建议和肯定句均交语义审阅判断，Host 不以词命中推断句意。显式 `data-claim="visual"` 的注册媒体与实际原生交付校验保持失败关闭。既有 `data-host-limitation` 诊断在再次验证时从 Agent 内容中抽离，按已知诊断身份统一去重投影；此前修复已移除坏媒体或引用时保留对应诊断，废弃的视觉词表诊断不再投影。该处理支持旧 boolean 标记及旧译文，只在显式验证/重建时发生，读取历史已发布文件不重写。重复验证同一规范化草稿不追加诊断或改变 digest。现有核验词表只提示“使用核验措辞而无可解析证据”，不证明自然语言核验主张成立；显式 `data-claim="verified"` 仍须可解析证据。

`candidate/process-index.tsv` 及其 briefing 副本的每行新增 `observation_path`，直接指向 `observations/events/run/` 中同一事件的 JSON。路径复用 History observation materializer 的 canonical 规则；完整索引包含结算后事件，事件 type 与字节数只供导航，不能证明检查成功、失败或没有执行。`briefing/decision-map.md` 另外给出最近最多 6 条 `runtime.tool_finished` / `runtime.visible_output` 的路径，并注明遗漏数量；选择仅依据事件类型，不做内容结论，不要求全日志扫描。验证自述应打开对应工具结果负载与可见输出核对。观察文件沿用 `truncated` / `originalChars`：被截断的片段不能证明未显示的剩余内容，需取得完整注册来源或保留该限制。

封存历史终稿不按扩展名过滤导航：manifest、真实路径边界、长度与 hash 通过检查的文件进入 catalog，取得 `ev-*` 引用，保留原 artifact、来源身份与完整来源集合。来源容量沿用历史 artifact 协议，不因摘要展示截断而丢失；缺失或身份不符的文件不伪造为可用。原始 bundle 仍留在 `finals/`，不要求 Agent 复制到 scratch。通用导航证据不是渲染媒体，只有现有 renderer 支持的类型可用于 `render_artifact`；未知扩展名不获得额外执行或渲染权限。

新注册的派生证据按内容 hash 保存，并仅在内容与所声明的 HTML/SVG/PNG/JSON 类型相符时保留安全扩展名；HTML/SVG 只允许静态元素和属性，发布旧 catalog 文件时再次检查；旧无后缀记录仍可读取。正式根报告引用的派生证据经过 hash 和路径校验后复制到根目录 `evidence/<hash>.<ext>`，预览继续使用 attempt 内路径。`report-model.json` 的 `evidenceRefs` 保留原事件/artifact 引用，同时以可选 `evidenceIdentities` 保存派生短引用、hash 和 source refs；旧 model 可继续读。取舍见[证据身份与可达发布](../decisions/accepted/2026-09-28-comparison-evidence-publication.md)。

Host 预置 HTML 模板并拥有 header、metrics、cost-note、evidence、process 等区域；新报告 `data-report-format="2"` 的 Agent 区为 `comparison`（主创作）与可选 `details`（可见 `<details>`）。Agent 在 `comparison` 内自主选择并排图、表格、短片段或步骤；无图时不强制空视觉段；单侧真实结果可保留但须就近写明缺失方。Host 从草稿中结构化提取唯一、完整的 Agent 区与允许的槽，以本 attempt 的任务、指标、证据、媒体和受控模板重建整页；不明确的槽边界拒绝提取。Agent 区禁止可执行标签、SVG/MathML、事件属性和危险 URL；只允许链接的 `href` 与图片的 `src` 使用相对 URL，图片仍须经过媒体登记和文件可读性检查，其他资源属性直接拒绝。矢量内容须作为已登记媒体进入报告。重建后仍经过 schema、HTML 契约、evidence/media 引用、模型已见图片和外部资源检查，失败则不发布。展示问题由 Host 确定性修复，无法修复时记录 limitations 并仍可发布，不能把所有样式问题提升为失败门禁。Agent 的自然语言判断不能覆盖确定性事实，证据缺失必须明确说明，不得伪造引用。版式与发布取舍见[自主任务比较报告区与安全发布](../decisions/accepted/2026-09-19-comparison-autonomous-report-zones.md)和[Host 重建报告](../decisions/accepted/2026-09-23-host-rebuilt-comparison-report.md)。

新 format 2 报告在短结论后先显示时间与估算费用，再展示比较正文；Token 总量与分项默认折叠。Host metrics 的 `data-metrics-layout="compact"` 标记约束新顺序；旧无标记的正文先于指标布局和四字段指纹仍可读取，不重写旧报告。时间保留分秒，极小正费用显示 `<0.001` 美元，避免舍入为零。费用说明价格快照、非供应商账单和工具费排除，Token 分项可能重叠或缺失，不能直接当作跨工具效率评分。

候选 Token 与单模型估算费用仅聚合 `runtime.` 事件，再按候选 Runtime 模型定价；同 run 的 Controller、Recovery、Comparison Agent 用量不计入候选指标，重复比较不得改变原候选成本。没有 Runtime telemetry 时保持未知，不借 Harness 用量补齐。Comparison 开销仍保存在该 attempt 的独立资源记录；新检查从原 journal 重算，不原地改写旧报告或冻结 facts。见[Runtime 用量归属](../decisions/accepted/2026-10-06-runtime-usage-attribution.md)。

Agent 区的内联 `style` 属性和原生 `dialog` / popover 浮层一律拒绝，避免遮盖 Host 的任务、模型与指标。

## 报告发布

正式报告是 experiment 根部的 `report.html` 及其媒体。新流程用 `submit_comparison_draft` 接收 category、headline、comparisonHtml、可选 detailsHtml 和证据不足状态；Host 即时校验并生成完整页面。模型文件工具不能直接改写新流程的 `report.html`，自定义旧端口仍可按旧整页契约写 attempt 草稿并接受末尾发布校验。新流程仅在草稿完整校验通过、当前 catalog revision 与草稿 digest 均匹配成功 `preview_report`、审阅调用正常完成且未取消时发布；末尾自由文本为空不阻止有效版本发布，也不表示模型作过最终质量确认。`publishComparisonArtifacts` 先把被引用媒体拷到内容寻址路径（`media/<hash>.…`）并校验，再写审计 `report-model.json`（含 `formatVersion: 2` 与 `comparison` / `details` slots；旧四区 model 仍可读），最后原子替换根 `report.html`。失败或取消不得覆盖旧成功报告仍引用的资产。

`inspect_comparison_draft` 为审阅返回当前已接受报告的实际 Agent 内容和版本绑定，省去整页 CSS；文件 digest、catalog 或 findings 绑定变化时不可用，无已接受草稿的旧端口也明确不可用。该读取走现有工具审计，不新增第二份权威草稿，不代替实际来源核对或 `preview_report`。审阅先核实际主张，再批量修订、预览当前 digest 并结束；预算以内的篇幅优化反馈是建议，不要求为了字数反复提交。只有改变任务判断的限制须主文可见，常规来源、缺失编辑历史和指标方法可放详情。

新模型工具提交须声明 `decisionShape`：一个独立决定性差异为 `single_difference`（标题与主文最多 250 字符），多个独立差异为 `multiple_differences`（最多 600）；同一缺陷的证据、后果与重复描述不算多个差异。超限拒绝保留旧已接受版本和预览绑定，不发布新稿。详情不计主文字数，但不能隐藏改变判断的反证。声明是模型的分类，Host 仅验证字数，分类正确性与决定性完整性仍须语义审阅。旧直接端口及无声明草稿继续按原契约读取。

生产提交工具还要求纯文本 `decisionSummary` 与 `decisionBoundary`：前者表达本次任务的实际可用性及用户取舍，后者表达改变判断的重要未知或反例。已有 findings 重要限制时不能交空边界；没有已识别重要限制时允许为空，不自动生成结论。Host 转义后将两者前置到普通比较主文，复用总篇幅、真实 inspection、digest 与 preview 约束，不另存新的报告字段。字段与可见性检查不能认证判断、覆盖完整性或自然语言真实；技术测量不替代任务级结论，压缩不得删去另一个改变可用性的关键维度。见[决策摘要契约](../decisions/accepted/2026-10-06-comparison-decision-summary.md)。

当前 findings 工具的双侧观察还要求 `supportBoundary`，明确实际输出关系、范围、支持阶段、已覆盖与未检实例；中间目标不能凭数学一致性升级为实际交付。当前草稿通过 `decisionBasis`、`conclusionScope`、`findingDispositions` 为每个当前 finding 指定一次决策角色并绑定依据。依据或边界有中间结果、不可得或未检实例时，充分支持声明被拒绝；相关未知按 finding 在主文保留任务标准、涉及侧和局部或未确认性质；完整观察范围进入详情，仍计入原主文与详情限额，重要决策未知必须由 decisionBoundary 留在主文。有条件或未定结论可以正常结束。字段和角色均为模型声明，不能认证完整性或自由文本语义。引用归属、未知或缺失拒绝会给出具体字段位置、提交引用的实际注册侧及最多十二项相关目录，含省略数量；额外目录读取受原阶段资源约束，不承诺不可执行的分页读取；不泄露私有路径，不自动替换引文或认证语义，拒绝不改变 accepted 状态。基础字段 optional 使新 reader 兼容旧记录，旧 reader 不保证读取新支持范围记录。见[支持范围契约](../decisions/accepted/2026-10-06-comparison-support-boundaries.md)。

`render_artifact` 的实际返回附 `renderedCheck`：来源/hash、结果、请求采样时间、实际帧时间/hash 与 viewport；同 PNG、登记失败也保留已发生的渲染事实，不含物理 PNG 路径，不证明视觉查看。该摘要进入原有工具结果审计，可从日志复原。生产 attempt 保留最近 24 条结果及遗漏数供 `inspect_comparison_draft` 在新 Session 读取；同进程历史不是第二份持久化权威，恢复后不可由空列表推断没有检查。摘要明确属于 Comparison 的检查，不能冒作候选 Runtime 检查；当前 Session 图片交付单独从实际交付集合投影，换 Session 不能继承权限。

可选 `geometryQueries` 在每个采样中观测最多 8 个唯一 selector 查询的 SVG line/path 起终点、circle/ellipse 中心/半径点或 DOM bounds。Host 固定采集器在独立 execution world 中运行，局部 SVG 点经实际 `getScreenCTM` 转为 `viewport_css_pixels`；缺失、歧义、无效 selector、不支持及不可测量均明确返回。外部结果经 core schema、16 KiB UTF-8 上限、身份/顺序/时间与点位映射检查。`geometrySample` 随工具正文与 `renderedCheck` 进入原审计，包含独立观测窗口，随后才采 PNG，不能宣称严格同瞬间。数值不证明元素语义、无遮挡、美观或整个动画正确，也不授予图片查看权限；旧调用不带查询保持原行为。见[渲染几何观测 ADR](../decisions/accepted/2026-10-05-comparison-rendered-geometry.md)。

核稿时若接受文件 digest 正确、但 catalog/findings 绑定过期，`inspect_comparison_draft` 返回 `stale` 的实际作者正文、检查事实与历史问题身份，供按独立证据修复；不返回有效 inspection receipt，不满足最终检查、预览、发布或恢复。文件缺失/篡改仍 unavailable。findings 更新是完整替换，历史 ID/question/decisionImpact 不可抹除；缺失或状态错误返回具体修复材料，拒绝不改变已接受记录。历史解决解释不是认证证据，不能自动沿用为独立结论。严格 source pass 允许基于实际查证更新 findings，初始保存记录仅作为待证假设；inspection、submit、write/edit和preview仍拒绝。其他旧端口继续拒绝source findings更新；实际完整草稿只在后续正文检查点取得。

findings 收尾仅允许保存已取得的观察。内置 Pi 每次收尾调用的实际模型可见工具集只包含 `update_comparison_findings`，在调用空闲并完成 usage 审计后恢复原工具集；原执行拒绝、取消及资源保护继续生效。其他 Provider 可忽略可选暴露参数，不能据传参声称已隐藏工具；实际集合以 generation 快照为准，见[收尾工具暴露 ADR](../decisions/accepted/2026-10-05-comparison-findings-tool-exposure.md)。限制工具列表不保证模型及时保存发现或判断正确。

默认内置路径通过 `update_comparison_findings` 保存任务标准、双方最终来源、观察方法与支持范围、反证、重要限制和判断问题。Host 校验引用归属及结构，不证明自然语言主张正确；不可变发现 artifact 和 `comparison.findings_updated` 绑定 attempt、revision、catalog revision 与 digest，工具回执沿用模型输入审计。问题历史不得静默删除，重新打开已解决问题需新依据。问题须解决或说明证据不可得才进入创作；旧自定义 Comparison 端口保留原契约。

草稿接受版本通过 `comparison.draft_accepted` 同时持久化 discovery revision、catalog revision 与 HTML digest；离线恢复核对最新发现 artifact 与接受绑定，并要求匹配预览事件发生在绑定之后。发现变化使旧草稿不可发布，必须重新提交并预览当前版本。新内置提交路径按声明的单个或多个独立决定性差异，限制标题加可见主文为250/600字符、附属解释为400/1000字符；折叠和隐藏解释也计入，已核验的固定原文组件从附属解释中排除。旧自定义端口保留原契约，篇幅和结构校验不证明声明的差异数量或判断正确；常规来源/哈希检查复用Host事实，不因未重复而增造限制。检查方法或精确推导可展开，影响取舍的未知不得藏入详情；证据注册、同公式复算或单帧截图均不证明全局行为。

Comparison 是运行后的可选证据视图，不是新的实验状态机，也不为历史 Runtime 版本提供精确复现保证。报告失败不应改写 CandidateRun 的 outcome；失败诊断保留原任务和草稿排查路径，未经发布校验的草稿正文不能作为正式结论。报告中应明确 baseline、candidate、证据缺口和 cleanup 状态。

## 文件与兼容边界

TaskCase 通过 case.complete 发布，缺少标记的半成品不能作为完整场景。可选历史终稿封存在 `baseline-artifacts/manifest.json` 与配对的 `baseline-artifacts/files/<bundleId>/…`；旧 Case 无清单时由 attempt `derived-history/` 补证，不写回已发布 Case。Experiment 使用自身的日志与文件协议，不能套用 Case 标记。只读 History 不申请 writer 锁、不改写日志；未知 schema 和完整坏行需要诊断，不能跳过坏行拼出完整轨迹。持久化 compare 与历史摘要依赖 record.json；Store 能 replay 不证明记录文件丢失时应用会自动重建。

进入模型的正文先经过秘密过滤，再持久化并发送；超出内联预算的内容使用带 hash/长度的附件，重建时校验。Pi 内存 transcript 不是另一份持久化真相。角色工具读取的正文同样需要可复原的事件／附件记录，仅保存可变文件路径或 digest 不足以重建输入。

Comparison 每次使用独立 attempt。严格三会话路径的调查、短作者、独立 source/review 各自新建 Session；作者仅用原任务及实际保存假设，独立 source 初始输入不携带作者对话。其他新提交端口仍由调查与作者共用 Session、首次审阅另建 Session；后续修正复用其独立 Session。旧直接报告端口仍保持连续 Session。新提交路径按定向调查、提交、审阅三轮推进；首轮先读取确定性 briefing 索引，只追查会改变结论的问题。`comparison.phase_completed` 记录每段耗时、模型请求、工具调用、压缩和预览次数；旧四轮 JSON 信封仅保留给旧端口。可执行 Prompt 以 [`comparison-agent.ts`](../../src/agents/comparison-agent.ts) 与 [`comparison-review-findings.ts`](../../src/agents/comparison-review-findings.ts) 为文本源：以任务成功标准选证据形式，点名 `render_artifact` / `register_evidence` / `preview_report`；截图与页面查看只走这两个受控工具，禁止经 `shell_exec` 启动 Chrome/Edge/Firefox 或做 `--version` / `--dump-dom` / 用户 profile 探测；渲染失败则记录 limitation 并继续文本证据，不得用等价浏览器 shell 重试。Prompt 是第二道防线，不能替代 Comparison 工具装配层的 shell 边界。提交时 Host 检查短引用、媒体、结构和安全内容；review 须预览且改稿后重检。取舍见[草稿提交与版本发布](../decisions/accepted/2026-09-26-comparison-draft-publication.md)与[禁止直接浏览器 shell](../decisions/accepted/2026-09-20-comparison-prompt-no-direct-browser-shell.md)。Host 持有确定性指标和模板区域，Agent 写本次任务的差异与判断；未知 token、价格或用量不是零。候选 snapshot 缺失或不完整时明确 unavailable，不能悄悄改读可变运行副本。

生产 `requireFindings` 路径在初始调查实际 `bounded_investigation_timeout` 后，若 findings 未 ready，由 Host 串行关闭已接受 snapshot 中的 pending 问题：仅改为 unavailable 并注明调查截止，保留原身份、decisionImpact、引用、nextCheck、观察和限制。复用原当前 catalog 校验与 artifact/event 持久化；没有保存、引用失效、取消或持久化/审计失败不得 compose，不付费重写占位。`comparison.investigation_closed` 记录前后绑定、问题 IDs 和非语义认证的过程来源；下一真实模型输入明确带入该来源，不伪造模型 tool call。独立 source、实际 reviewer findings 更新、重新正式 inspect 和 preview 链保持必需。取舍见[Host 调查截止闭合](../decisions/accepted/2026-10-06-comparison-host-investigation-closure.md)。

严格新审阅首轮得到原context导航及当前saved findings绑定、ID和待证假设，独立读取原任务、决定性来源及实际交付链，不携带作者对话或打开作者稿。source实际工具面仅含合法source工具和update_comparison_findings；查证后立即保存，不以文字总结代替持久化。独立source marker只记本次精确accepted回执和实际非空saved state，正文检查点不重置它；当前state须仍完全一致，ready须重新检查。只有source正常completed或明确independent_findings_ready/pending边界才可使用该保存事实，旧ready、缺失state、拒绝、伪回执、超时及output_limit不能跳closure。实际accepted-ready在完整工具turn让出independent_findings_ready，取得真实完整草稿后直接full audit；accepted-pending让出independent_findings_pending，取得草稿后仅一次补查再最终closure。没有有效source保存证据则执行原最多两次review-findings，每次重置closure accepted标记；只准update及严格修复read，实际accepted且当前ready才能进入audit，相同合法snapshot可幂等接受。第一次closure接受pending也仅开放一次review-supplement，不写稿、提交、更新findings或预览，之后最后closure必须从真实证据解决问题或保留身份、历史、decisionImpact并明确unavailable；仍不ready就失败，无第三次。source保存不认证事实，不豁免实际稿件checkpoint、full audit、新正式inspect、后续generation和matching preview。旧source端口不注入作者findings、继续禁止source更新，并保持原两次closure。见[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。工具、catalog、draft、阶段状态、审计与资源 tracker 仍属于同一 attempt，模型请求、工具、累计费用和开始时间不因换 Session 重置。创作失败不创建审阅 Session；attempt级取消signal跨会话存在，cancel与进行中的release先取消attempt再关闭当前缓存Session；旧Session关闭空档中取消也不创建付费review，新Session图片交付权限从空集开始，不继承旧Session图片。取消与release指向当前缓存的新Session，返回的 sessionId 来自实际审阅，模型输入仍逐请求审计。换会话本身不增加审阅轮数或并行模型调用，也不放宽预览、digest 与原生图片交付要求。

旧 attempt 可通过 `recover-comparison` 离线复核：只读冻结 context、catalog revision、预览事件与原草稿，重新运行当前校验器。缺失预览、digest/revision 不一致或校验失败不得恢复；`--publish` 是显式操作且拒绝覆盖已有根报告，成功后追加恢复事件，不篡改原失败事件。

默认新路径以一次定向调查进入创作与审阅；旧四轮端口仍保留阶段边界。调查按下一项检查能否改变取舍、证据强度或重要限制决定是否继续，不把调用次数当成充分理解的标准。可配置 `AgentBudget.comparisonResources` 另提供调查软预算和整体硬保护，生产工厂默认调查 12 次模型请求 / 30 次工具 / 120 秒，整体 40 次模型请求 / 120 次工具 / 600 秒，不默认启用金额上限；调用方传入 `comparisonResources` 完整替换默认值，`{}` 关闭这些保护，复杂任务须显式调高。软预算限制继续调查，但允许保存带限制的发现并完成创作审阅。硬保护或取消不发布无效草稿，不覆盖旧成功报告。Pi 的生成与压缩分别审计实际模型请求和 `agent.usage_reported`；阶段与结束事件记录资源。金额保护基于已返回 usage 和价格估算，缺失时拒绝继续，不能精确限制在途费用或替代供应商账单。协议见[关键发现与资源保护](../decisions/accepted/2026-10-05-comparison-scoped-findings-and-resource-protection.md)。

旧端口未启用局部 deadline 时，调查与 source pass 的软预算在 Pi 完整 turn 的安全边界机械执行：usage 汇报后，Host 的 yieldAfterTurn 通过 SDK 现有 shouldStopAfterTurn 阻止下一次生成，返回明确 yielded，记录 agent.invocation_yielded；comparison.phase_completed 附实际 outcome、pass 与 yieldReason。它允许正在执行的 Provider 请求与整批工具完成，不宣称精确抢占；原整体硬预算不变。调查可用剩余额度做至多两次实际 findings closure invocation；严格路径同样受原调查阶段绝对截止约束，不能因 closure 重新获得时间；closure 工具边界先检查共享硬额度，再机械拒绝除 update_comparison_findings 以外的工具，软额度未耗尽时也不允许新调查；内部工具反馈可在同次调用继续修正，仅真实 findingsReady 就绪后才 findings_ready yield 并进入 compose，口头承诺不制造保存状态，第二次仍未就绪即失败；source pass 被让出时明确不完整，未知成功保证不得认证。draft 收尾不按累计 review 软额度在每个内部 batch 后退出，允许修复历史发现、重提、正式 inspection、preview 及后续 generation 在同次调用内推进；扩展 read/render/register 调查继续按原软限制拒绝，共享硬额度和无进展边界不变。Provider 必须 idle 才能进入下一阶段；取消、真实错误与硬失败优先。正式发布还须证明当前完整 inspection 已进入后续 generation 实际输入，inspect 与 preview 同批成功不足以立刻 report_ready。生产新路径在每次实际核稿开始时撤销正文检查点的正式认证和旧预览，保留已经真实送入 Session 的正文用于核稿；只有该核稿边界之后新完成的正式 inspection 才能让出并进入收尾，拒绝读取或口头结束不能沿用旧认证。新增 comparison.draft_audit_started 记录此边界，新的 reviewInspectionContractVersion=2 在 live/Recovery 都要求最终 inspection 晚于当前 audit-start；新 reader 兼容版本 1，旧 reader 拒绝版本 2。在实际完整核稿 turn 后，让当前正式 inspection 进入同 Session 的下一次真实 generation，再仅执行 preview_report；该工具 turn 完成审计后即可 report_ready，无须预览后额外纯生成。预览失败或版本失效回到有界核稿修复，取消、硬限与真实错误仍优先；旧无 getter 端口保持原流程。新 audit 调用开始时若 reviewReason 已耗尽，实际工具集合按原资源策略隐藏执行边界本来拒绝的扩展检查，保留 read 供合法修复及检查、提交；未耗额度仍保留扩展检查，原执行守卫不变。见[仅预览收尾](../decisions/accepted/2026-10-06-comparison-preview-only-closure.md)与[安全阶段让出](../decisions/accepted/2026-10-05-comparison-safe-turn-yield.md)。

严格三会话路径独立 reviewer 使用专用短系统提示，保留实际来源、输出链、反证、支持范围、问题历史、Host指标和版本发布约束；首次source输入隔离作者对话，但包含当前saved findings的绑定及待证假设，保存记录始终不作事实认证，优先绑定 delta 与紧凑 decision，减少重复输入和输出。旧端口保留通用提示，不调整模型参数。严格核稿仅 completed 或明确 final_inspection_ready 才进入预览，output_limit 或阶段截止不能凭旧 inspection 发布。

严格三会话路径且配置 maxElapsedMs 时，初存、调查及 findings 收尾共享同一个调查绝对截止；作者、独立来源审阅（含正文检查点、findings闭合及唯一补查）、audit 和 preview 也各有一次共享绝对截止。600秒基准下阶段上限分别为120/90/150/90/90秒，后续预留分别为480/390/240/150/60秒；较小整体额度同比缩放，较大额度不扩大阶段上限。来源初查与保存合并窗口另限110秒、唯一补查另限30秒，两者不得越过共享审阅截止。更小 investigationMs 继续限制调查；严格调查已有实际保存且当前ready时，在完整工具turn提前findings_ready让出，不必须耗满上限。重复进入阶段、修复及 output_limit 续写不重置截止，过期不发新请求，修复工具也不豁免。阶段快照记录 workStage、workDeadlineAt、workRemainingMs，实际控制由 invocation-start 的 yieldDeadline 复原。截止是未完成过程，不认证语义；实际已保存观察及关键未知保留，真实错误、取消、持久化/审计和整体硬限优先。非严格端口保留原调查局部截止与 closure 兼容策略。见[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

显式启用 turn-yield 的 Pi 调用遇到输出截断 `length` 时返回 `output_limit`，不调用完成策略或认证该回合已完成。Comparison 在同 work/phase/pass 内最多续写一次，保留 Session、审计 epoch、已执行工具结果和首次局部绝对截止；两次请求都计原资源账本，第二次仍截断则失败。真实错误、审计错误、取消和硬限优先，不以纯推理耗完输出额度作为审稿通过。写稿和审阅输入同时呈现当前 Host 双侧指标，缺失为 unknown、零仍为零，避免继承旧报告价格结论；这些输入由原事件及 generation snapshot 复原，仍不能认证自然语言判断。见[有界截断续写](../decisions/accepted/2026-10-06-comparison-output-limit-continuation.md)。

独立 source pass 另传入本次调用的绝对 `yieldDeadline`，严格路径由共享审阅阶段与初查/补查的较小截止计算，旧端口按原累计来源额度与整体收尾预留计算，不增加默认整体预算。Provider 在截止时仅中止当前执行，等待真实 idle 与 usage 审计后才返回明确的 `bounded_source_timeout` yielded；这是未完成的来源审查，可能没有可见 assessment，不能称完整 turn 或成功验证。控制配置随调用开始事件记录，模型实际输入仍以 generation snapshot 为准。外部取消、整体硬限及真实 Provider、工具、审计错误优先；旧 Provider 忽略可选字段时，普通 timeout 不被追认为局部让出。随后核稿使用同一独立 Session 已实际读取的材料，保留未知，仍须当前正文、预览与后续实际 generation 绑定，不跳过发布门禁。见[来源复审局部截止](../decisions/accepted/2026-10-05-comparison-source-yield-deadline.md)。

生产提交路径在独立 source pass 后增加只读正文检查点：本次调用只允许实际 inspect_comparison_draft，完整当前稿或明确未认证的过期稿成功交付后才开放改稿与预览。Getter 是同进程交付事实，不是语义通过；过期材料只能用于修复，不设置正式 inspection 认证。最多两次实际检查点调用，不能以口头承诺、unavailable 或工具失败解锁。后续仍须当前正式 inspection、preview 与实际 generation 绑定；旧端口缺少该 getter 时保持原行为。见[核稿正文检查点](../decisions/accepted/2026-10-06-comparison-review-draft-checkpoint.md)。

创作后、审阅前，以及审阅改稿后，Host 用与正式发布共用的 HTML 解析器预检草稿 Agent 槽/区；可修结构错误反馈给同一 Session，草稿 digest 与错误重复则以无进展失败退出。`preview_report` 在渲染前做同一结构预检，返回 `publicationStructure`，但结构有效或渲染成功都不代表最终可发布；完整证据、媒体、信封与 Host 重建校验仍在正式发布时执行。取舍见[对比阶段出口与草稿预检](../decisions/accepted/2026-09-25-comparison-stage-exits-and-draft-preflight.md)。

Host 对 HTML/SVG 终稿做受控无头渲染（`infrastructure/artifact-renderer.ts`：127.0.0.1 bundle 服务 + CDP；raster 直接拷贝），经 `headless-screenshot.ts` 委托；双侧有视觉交付但 media 无可用配对时 `media_unavailable`。`render_artifact` / `preview_report` 工具工厂见 `comparison-render-tools.ts`，预览与发布共用 `preparePublishableComparisonHtml`（format-2：仅在 `comparison` / `details` 区内把 `data-media-ref` 写成可加载 `src`）；预览图属 host review（独立 `review-*` 短引用），不进入比较证据 allowlist。取舍见 [受控产物渲染与报告预览](../decisions/accepted/2026-09-19-controlled-artifact-render.md)。详情见 [attempt 装配](../../src/application/comparison.ts)、[发布](../../src/application/comparison-publication.ts)及[持久化比较入口](../../src/application/experiment-compare-persisted.ts)。

`preview_report` 只复制准备后页面实际引用且 hash 匹配的媒体与派生证据；被引用的历史终稿另从 `finals/` 复制到受控预览根目录，HTML 终稿连同其 bundle 资源复制，并将内容 hash 纳入依赖摘要。草稿中的历史终稿链接为 attempt 相对的 `finals/`；正式根报告改写为 `comparison-attempts/<attemptId>/published-finals/<digest>/finals/`，指向已改写根相对资源的内容寻址副本，封存原件不变。准备目录按草稿、catalog 与依赖内容隔离。`render_artifact` / `preview_report` 成功结果附现有 `read(format=image, mimeType=image/png)` 的相对路径参数；渲染或登记本身不等于图片已交付模型。相同依赖和 viewport 的成功截图可在本 attempt 内复用，缓存命中仍重查文件并保持工具审计；取消和失败不缓存。预览缓存不参与正式发布校验。

预览的静态 mechanics 只统计活跃 DOM，忽略 `<template>` 原型；`hostMetricsPresent` 表示标记存在，不声称它位于首屏。受控渲染器另回传指定页面元素的布局位置、首屏可见状态、页面尺寸及图片加载计数；截图只覆盖请求的 viewport，不能据首屏预览宣称全页已检查。TUI 从 `agent.session_started` 展示 Comparison Session 实际模型输入能力；自定义模型未声明图片时仍按 text-only 处理，配置开关不是网关能力探测。主动停止 Claude Runtime 后的预期进程关闭保留 `session_stopped`，不再写 `runtime_failed`；非预期关闭仍记录失败。

## 事件信封字段

Comparison 合成评估的新输入由每个隔离 row 的 `evaluation-inputs.json` 绑定，schema 定义在 `src/core/comparison-evaluation-input-schema.ts`。plan/ledger 记录该文件 hash，并核对 suite 变体 hash、已有输入文件内容及 committed 事件前缀；比较追加事件与新审计 artifact 不重写这个前缀。真实调用前校验全部选中 row，汇总前重查绑定。配置与凭据目录不进入输入清单；旧未绑定结果需另附离线一致性核验，不能用事后快照证明历史不可变性。

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

严格三会话路径所有审阅 work pass 使用共享阶段绝对截止；扩展调查在 attempt 剩余请求不超过4或工具不超过6时停止，为合法修稿、inspection 和 preview 留资源，任何工具均不能越过阶段截止。实际 findings更新只校验结构与来源，不自动回答未知问题；决定性 unavailable 必须使结论 conditional/undetermined 且边界可见。非严格路径继续原复审累计软额度，repair不重置，剩余不超过6请求、20工具或90秒时拒绝扩展检索/渲染/登记。各路径硬限与取消仍生效，工具回执附真实阶段、余额和绑定，经标准事件复原；不以旧预览兜底。空资源 override 保持兼容。

Comparison的read结果现在只将实际存在的available/truncated/offset/byteLength/returnedBytes/totalBytes/nextCursor白名单投影到模型可见hostProgress.readCoverage；类型不符或缺失不补造false/0，不透出物理路径/任意details。读取覆盖描述本次返回范围，不保证原运行完整记录；模型不能因正文很长猜测截断。该反馈与原工具结果一同审计/压缩/恢复，文本和原生图片工具实际块均可见，旧直接端口不受影响。

Comparison 的 `quote_evidence` 只读取当前 catalog 的已登记文本引用，并从实际 UTF-8 字节生成带 ref、完整来源 SHA-256、字节范围及全文/节选标签的固定 HTML。原文展示复用该组件；派生解释不能冒称原文。提交、预览、发布和离线恢复重读安全 mounts 并核验组件，不因先前工具成功而跳过来源变化检查；有组件却无法验证则拒绝，无组件的旧报告保持兼容。工具尊重 allowModelText，拒绝二进制、非法 UTF-8、越界或切断多字节范围以及超出 16KiB 输出的请求，不静默截断。该能力认证引文字节和范围，不认证自由文字中的事实、判断或完整性；这些仍须语义审阅。

新生产独立复审须在最后一次接受修订后重新读取实际正文，绑定当前稿 digest/catalog/findings/声明；作者阶段读取不跨 Session 生效。预览仍负责布局，不返回全部解释正文，不能代替该读取。恢复对新启用契约的 attempt 校验当前 review Session 的读取记录，旧未启用报告保持兼容。主文250/600以外，单差异附属解释最多400、多差异1000字符，包括隐藏或折叠解释，排除已核验的固定原文引文。读取与篇幅门均不认证语义正确。

独立复审在同一新 Session 内先审原任务与决定性原件，再核接受稿；严格来源初始输入将保存findings作为待证假设及绑定导航，旧端口不注入作者findings；取得实际正文后仍只将保存记录作为修复假设；严格路径共享审阅阶段截止，其他旧路径累计原 review 软额度，均累计同一 attempt 硬额度。来源审查优先追实际输出链并寻找决定性反例，不能把内部目标或作者自检当作最终输出验证。第一调用失败或取消不会进入核稿，稿件 inspection/submit/preview 在来源审查阶段拒绝；read/shell 未隔离作者文件，因此该顺序保护不是完全盲化。第二调用沿用自己的来源审查上下文，修订后仍须最终正文读取和当前版本预览；正常完成不认证语义。

Comparison 紧凑 decision 的 Host 范围投影按精确相等共享字段，保留依据及双侧范围映射；不同范围和未知不合并，自动文字仍计入原详情篇幅。作者不得仅为满足篇幅改变 findings 的检查范围或 disposition。workspace 工具的纯非法路径前置拒绝允许模型纠正合法虚拟路径，仍审计实际失败；权限、真实文件系统、审计及持久化错误边界不变。见[收敛改造](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

紧凑 decision 的 scopeSummaries 是报告展示层：每项 basis/boundary 对应一个 findingId 及历史/当前双侧简短范围，非空白并精确覆盖当前ID。Host 转义展示且计入原详情预算；完整supportBoundary保留于findings，既有legacy稿无此字段仍完整投影。独立正式audit每轮收到当前完整saved state与实际稿件，真实消息和generation snapshot保留revision/binding和全部范围；摘要的语义仍须独审，结构通过不认证它。固定Host导航不触发6次实际来源检查后的保存点，资源与审计照常计入；恢复不重复整份briefing。闭包截止立即失败，避免记录不存在的额外模型请求。

来源窗口因 bounded_source_timeout 中断后，只进入一次实际最终 findings 关闭，不再补查；旧保存状态不能替代该完整动作。未知仍由模型显式处置，随后实际核稿和版本匹配的发布门禁继续执行。原始生成是否截断只能依据原事件明确字段；完整读回执不能证明生成完整，无关导航库存不进入任务取舍。
