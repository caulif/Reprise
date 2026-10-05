# 证据、持久化与 Comparison

## 事件日志与文件

每个 Experiment 目录由 [`ExperimentStore`](../../src/infrastructure/store/experiment-store.ts) 管理：`events.jsonl` 追加事件，`writer.lock` 保证单写者，`runs/<runId>/attempt.json` 和 `manifest.json` 通过 `writeImmutableJson` 保存不可变快照，artifacts 旁有 manifest。Store 重开时会读取并校验事件；只读打开不改日志，取得 writer 锁后才按字节截掉不完整尾行，保留完整事件的原始字节。这提供 replay 能力，不等于应用启动会自动安全续跑未完成实验。

事件有 sequence、eventId、type、可选 runId/operationId、payload、occurredAt 和 checksum。提交请求入队时先取得与 JSONL 一致的 JSON 快照，追加前总是校验 `EventEnvelopeSchema`；对 Controller、Comparison、候选用户可见 turn 等已登记事件再校验专用 payload schema，未登记 type 不会获得额外的通用 payload 结构校验。Store 持有的已提交事件深度冻结，追加返回值、订阅参数和 `events` / `eventsSince` 的元素都不能改写日志事实；读端只复制结果数组，不重复深复制全量 payload。重复 operation 在相同 type/run/payload 时幂等，不同数据会失败。去重范围仍是整个 Experiment；run 所属操作由各自写入者从 runId 与局部 ID 派生独立、有界的 operationId，旧事件原样重放，见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

持久化边界使用 `Value.Check`：RunAttempt 必须先于 RunManifest；模型输出、外部 JSON、artifact manifest 和比较 briefing 经过对应 schema。Artifact manifest 的 schema 位于 core；Store 读取时校验版本、owner、ID 与路径，读取正文和幂等重试还校验长度/hash。成功 artifact 必须有与 `sourceEventId` 对应且归属匹配的 `artifact.created`；同内容但缺事件的残留也拒绝自动补提交，不覆盖原文件。并发 artifact 提交由 Store 串行处理。细节见[Artifact 提交事实与磁盘内容一致](../decisions/accepted/2026-09-23-artifact-commit-integrity.md)。实验没有生产 `experiment.complete` 标记；有效性由实际 spec、attempt、manifest、日志和读端规则决定，不应虚构该文件。

Recovery 的固定 artifact 与决定、诊断等不可变 JSON 按 `runs/<runId>/` 保存；默认 Recovery Provider 的 baseline 按 `environment/recovery/<runId>/` 隔离。baseline marker 的 `reportRunId` 指向 run 所属报告，旧 marker 缺字段时只查实验级报告；旧 scene 缺 `recoveryProviderRunId` 时继续使用 `environment/baselines/`。旧根级文件不迁移、不覆写，新读端按明确 owner 读取，不能用另一 run 的同名 artifact 填补缺失。

## 模型输入可追溯

Controller、Recovery、Comparison 都通过 Agent Session Host 生成模型请求。Host 把 system prompt、用户消息、工具结果和结构化结果写入审计事实；[`model-input.ts`](../../src/infrastructure/agent/model-input.ts) 从事件日志重建请求。上下文压缩必须追加 `agent.context_compacted`，其中 summary 与 retained tail 是后续请求可见的输入来源。新增模型可见事实必须先写入事件审计（必要时再由 briefing 做可读投影），不能只存在内存变量。

压缩请求另在 `agent.model_request` 的 `compactionInput: AgentTextBody` 保存实际上下文，仅含 systemPrompt、messages 与 tools；经同一秘密过滤的上下文用于审计和发送，不保存 Provider 凭据或只留不可重建的 digest。大正文沿用附件溢出、字节长度与 hash 校验，图片记录为不可变附件引用，不把 base64 写入日志。History 重建可返回独立的 `compactionRequests`，不将压缩混入普通生成请求；历史缺输入体标记 contentComplete=false，附件缺失、损坏或图片校验失败保留不完整与诊断，不把压缩后的 summary 当作压缩请求原始输入。

TUI 读取这些事实并投影状态。它不持有 CandidateRun 状态机，不展示未公开的内部推理，也不把模型输出未经 schema 校验地当成事实。

History 从已校验的提交日志前缀构造只读附件读取器，每个 Session 按起始事件的 runId 绑定正文和图片读取范围；复用 Store 的 manifest、owner、提交事件及字节/hash 校验。完整图片记录不标成内容缺失，缺失或损坏附件保留诊断并标记输入不完整。此路径不创建目录、取得 writer lock 或改写未提交尾部。

## Comparison attempt

Session 以有效 Provider 冻结身份、API、输入能力、声明来源与无凭据配置指纹，Session 声明冲突则取消。图片工具结果、压缩 retained tail 和最终 `agent.model_request.images` 保存不可变附件的 hash、长度与 artifactId，不存 base64。最终清单反映 Pi 转换后的实际图片；视觉声明和离线恢复优先依据这些实际清单，只有无清单的历史日志沿用旧交付事实。重建校验附件，无附件或二进制 resolver 时标记不完整，读取失败与 hash 错误有诊断。文本裁剪保留最近 12 个原生图片块，旧图片换成 hash 与重新读取提示。

`render_artifact` / `preview_report` 的可选 `includeImages=true` 交付受控 PNG；默认仍返回文本引用。二进制权限来自 Case `privacy.allowBinary`，再由模型能力过滤，媒体存在不等于授权。附图检查登记路径的真实 attempt 边界、hash、PNG 头部尺寸与预算（4 张、单张 3 MiB、总 8 MiB、单张 9,216,000 像素），不交付部分失败的集合，缓存同样检查。头部验证不是完整解码。`imageDelivery` 区分 attached、not_authorized、unsupported_model、unavailable 和 budget_exceeded。

review 改稿回执保持当前阶段，相同 digest/revision 的幂等提交保留预览，不同版本失效。未满足预览条件时最多追加两次同 Session 审阅，无进展则退出；当前版本成功预览、正常完成和未取消的发布边界保持有效，见[原生图片链路与版本续审](../decisions/accepted/2026-09-30-comparison-native-image-pipeline.md)。

候选 RunRecord 完成后，Comparison 可由 TUI 或 CLI 显式启动，默认跳过。每次生成创建独立 `comparison-attempts/<attemptId>/`，写入 `INDEX.md`、冻结的 `observations/`、候选快照状态、facts JSON、证据短引用、媒体清单和工作区。历史会话与候选事件以只读快照挂载；`history/` 提供历史过程，`finals/`（shell：`REPRISE_FINALS_ROOT`）提供本 attempt 冻结或派生的历史终稿。Comparison Session 不运行 Runtime、不修改 CandidateRun outcome。

Briefing 另写有界的 `decision-map.md`：从冻结证据索引、可打开终稿发现结果、媒体状态与候选 snapshot 状态列出双侧交付线索和待核缺口。它只帮助定位，不确认最终版本或给出质量判断；原始索引与文件仍是核查依据。理解轮优先读取该入口，工具读取正文继续进入模型输入审计。取舍见[交付导航与预览复用](../decisions/accepted/2026-09-25-comparison-navigation-and-preview-cache.md)。

Attempt 作用域持有可修订的证据 catalog：权威 revision 落在 `facts/evidence-catalog/rev-N.json`，`CURRENT` 在 facts 镜像写完后原子切换；`briefing/facts/` 与 `facts/` 的 `media.json` / `evidence-index.json` 由同一 revision 派生。短引用 `ev-*` / `media-*` 为 2–6 位数字，append-only，不复用已分配编号。调查中可通过 `register_evidence` 追加派生分析（Host 强制 `origin=derived_analysis`）；成功注册写入 `comparison.evidence_registered`（attemptId、revision、source refs、content hash、artifact refs；不含 base64 或私人绝对路径）。mutate/persist 后若 emit 失败，同内容重试必须补发事件。`render_artifact` / `preview_report` 为 Host 受控预览入口（`experiment-report.ts` 挂载真实工厂；`sourceRef` 仅映射到冻结 `finals/`/受控 `history/` 或 candidate snapshot）。媒体记录可带 `sourceRef` / `contentHash` / `derivation`；seed/briefing 物化时对可用图片文件写入与原生交付同口径的 `contentHash`（文件字节 sha256）。`available=true` 本身不构成向模型发送图片的授权；另需 privacy/发送策略与模型 `inputCapabilities`。报告中的裸 `<img data-media-ref>` 可供人阅读；`data-claim="visual"` 还须对应媒体的 `contentHash` 出现在本 Comparison Session 实际交付的原生图片集合中（text-only 剥离后该集合为空，不得自称看过）。

普通正文中的“视觉检查”等自然语言不由 Host 词表解释为已看图主张：否定、引述、建议和肯定句均交语义审阅判断，Host 不以词命中推断句意。显式 `data-claim="visual"` 的注册媒体与实际原生交付校验保持失败关闭。既有 `data-host-limitation` 诊断在再次验证时从 Agent 内容中抽离，按已知诊断身份统一去重投影；此前修复已移除坏媒体或引用时保留对应诊断，废弃的视觉词表诊断不再投影。该处理支持旧 boolean 标记及旧译文，只在显式验证/重建时发生，读取历史已发布文件不重写。重复验证同一规范化草稿不追加诊断或改变 digest。现有核验词表只提示“使用核验措辞而无可解析证据”，不证明自然语言核验主张成立；显式 `data-claim="verified"` 仍须可解析证据。

`candidate/process-index.tsv` 及其 briefing 副本的每行新增 `observation_path`，直接指向 `observations/events/run/` 中同一事件的 JSON。路径复用 History observation materializer 的 canonical 规则；完整索引包含结算后事件，事件 type 与字节数只供导航，不能证明检查成功、失败或没有执行。`briefing/decision-map.md` 另外给出最近最多 6 条 `runtime.tool_finished` / `runtime.visible_output` 的路径，并注明遗漏数量；选择仅依据事件类型，不做内容结论，不要求全日志扫描。验证自述应打开对应工具结果负载与可见输出核对。观察文件沿用 `truncated` / `originalChars`：被截断的片段不能证明未显示的剩余内容，需取得完整注册来源或保留该限制。

封存历史终稿不按扩展名过滤导航：manifest、真实路径边界、长度与 hash 通过检查的文件进入 catalog，取得 `ev-*` 引用，保留原 artifact、来源身份与完整来源集合。来源容量沿用历史 artifact 协议，不因摘要展示截断而丢失；缺失或身份不符的文件不伪造为可用。原始 bundle 仍留在 `finals/`，不要求 Agent 复制到 scratch。通用导航证据不是渲染媒体，只有现有 renderer 支持的类型可用于 `render_artifact`；未知扩展名不获得额外执行或渲染权限。

新注册的派生证据按内容 hash 保存，并仅在内容与所声明的 HTML/SVG/PNG/JSON 类型相符时保留安全扩展名；HTML/SVG 只允许静态元素和属性，发布旧 catalog 文件时再次检查；旧无后缀记录仍可读取。正式根报告引用的派生证据经过 hash 和路径校验后复制到根目录 `evidence/<hash>.<ext>`，预览继续使用 attempt 内路径。`report-model.json` 的 `evidenceRefs` 保留原事件/artifact 引用，同时以可选 `evidenceIdentities` 保存派生短引用、hash 和 source refs；旧 model 可继续读。取舍见[证据身份与可达发布](../decisions/accepted/2026-09-28-comparison-evidence-publication.md)。

Host 预置 HTML 模板并拥有 header、metrics、cost-note、evidence、process 等区域；新报告 `data-report-format="2"` 的 Agent 区为 `comparison`（主创作）与可选 `details`（可见 `<details>`）。Agent 在 `comparison` 内自主选择并排图、表格、短片段或步骤；无图时不强制空视觉段；单侧真实结果可保留但须就近写明缺失方。Host 从草稿中结构化提取唯一、完整的 Agent 区与允许的槽，以本 attempt 的任务、指标、证据、媒体和受控模板重建整页；不明确的槽边界拒绝提取。Agent 区禁止可执行标签、SVG/MathML、事件属性和危险 URL；只允许链接的 `href` 与图片的 `src` 使用相对 URL，图片仍须经过媒体登记和文件可读性检查，其他资源属性直接拒绝。矢量内容须作为已登记媒体进入报告。重建后仍经过 schema、HTML 契约、evidence/media 引用、模型已见图片和外部资源检查，失败则不发布。展示问题由 Host 确定性修复，无法修复时记录 limitations 并仍可发布，不能把所有样式问题提升为失败门禁。Agent 的自然语言判断不能覆盖确定性事实，证据缺失必须明确说明，不得伪造引用。版式与发布取舍见[自主任务比较报告区与安全发布](../decisions/accepted/2026-09-19-comparison-autonomous-report-zones.md)和[Host 重建报告](../decisions/accepted/2026-09-23-host-rebuilt-comparison-report.md)。

新 format 2 报告在短结论后先显示时间与估算费用，再展示比较正文；Token 总量与分项默认折叠。Host metrics 的 `data-metrics-layout="compact"` 标记约束新顺序；旧无标记的正文先于指标布局和四字段指纹仍可读取，不重写旧报告。时间保留分秒，极小正费用显示 `<0.001` 美元，避免舍入为零。费用说明价格快照、非供应商账单和工具费排除，Token 分项可能重叠或缺失，不能直接当作跨工具效率评分。

Agent 区的内联 `style` 属性和原生 `dialog` / popover 浮层一律拒绝，避免遮盖 Host 的任务、模型与指标。

## 报告发布

正式报告是 experiment 根部的 `report.html` 及其媒体。新流程用 `submit_comparison_draft` 接收 category、headline、comparisonHtml、可选 detailsHtml 和证据不足状态；Host 即时校验并生成完整页面。模型文件工具不能直接改写新流程的 `report.html`，自定义旧端口仍可按旧整页契约写 attempt 草稿并接受末尾发布校验。新流程仅在草稿完整校验通过、当前 catalog revision 与草稿 digest 均匹配成功 `preview_report`、审阅调用正常完成且未取消时发布；末尾自由文本为空不阻止有效版本发布，也不表示模型作过最终质量确认。`publishComparisonArtifacts` 先把被引用媒体拷到内容寻址路径（`media/<hash>.…`）并校验，再写审计 `report-model.json`（含 `formatVersion: 2` 与 `comparison` / `details` slots；旧四区 model 仍可读），最后原子替换根 `report.html`。失败或取消不得覆盖旧成功报告仍引用的资产。

`inspect_comparison_draft` 为审阅返回当前已接受报告的实际 Agent 内容和版本绑定，省去整页 CSS；文件 digest、catalog 或 findings 绑定变化时不可用，无已接受草稿的旧端口也明确不可用。该读取走现有工具审计，不新增第二份权威草稿，不代替实际来源核对或 `preview_report`。审阅先核实际主张，再批量修订、预览当前 digest 并结束；预算以内的篇幅优化反馈是建议，不要求为了字数反复提交。只有改变任务判断的限制须主文可见，常规来源、缺失编辑历史和指标方法可放详情。

新模型工具提交须声明 `decisionShape`：一个独立决定性差异为 `single_difference`（标题与主文最多 250 字符），多个独立差异为 `multiple_differences`（最多 600）；同一缺陷的证据、后果与重复描述不算多个差异。超限拒绝保留旧已接受版本和预览绑定，不发布新稿。详情不计主文字数，但不能隐藏改变判断的反证。声明是模型的分类，Host 仅验证字数，分类正确性与决定性完整性仍须语义审阅。旧直接端口及无声明草稿继续按原契约读取。

`render_artifact` 的实际返回附 `renderedCheck`：来源/hash、结果、请求采样时间、实际帧时间/hash 与 viewport；同 PNG、登记失败也保留已发生的渲染事实，不含物理 PNG 路径，不证明视觉查看。该摘要进入原有工具结果审计，可从日志复原。生产 attempt 保留最近 24 条结果及遗漏数供 `inspect_comparison_draft` 在新 Session 读取；同进程历史不是第二份持久化权威，恢复后不可由空列表推断没有检查。摘要明确属于 Comparison 的检查，不能冒作候选 Runtime 检查；当前 Session 图片交付单独从实际交付集合投影，换 Session 不能继承权限。

默认内置路径通过 `update_comparison_findings` 保存任务标准、双方最终来源、观察方法与支持范围、反证、重要限制和判断问题。Host 校验引用归属及结构，不证明自然语言主张正确；不可变发现 artifact 和 `comparison.findings_updated` 绑定 attempt、revision、catalog revision 与 digest，工具回执沿用模型输入审计。问题历史不得静默删除，重新打开已解决问题需新依据。问题须解决或说明证据不可得才进入创作；旧自定义 Comparison 端口保留原契约。

草稿接受版本通过 `comparison.draft_accepted` 同时持久化 discovery revision、catalog revision 与 HTML digest；离线恢复核对最新发现 artifact 与接受绑定，并要求匹配预览事件发生在绑定之后。发现变化使旧草稿不可发布，必须重新提交并预览当前版本。主文长度和重要限制是审阅反馈，简单单差异约100–250中文字、多个决定性差异约300–600字，仅作任务自适应指导，不是硬字数门禁；常规来源/哈希检查复用Host事实，不因未重复而增造限制。检查方法或精确推导可展开，影响取舍的未知不得藏入详情；证据注册、同公式复算或单帧截图均不证明全局行为。

Comparison 是运行后的可选证据视图，不是新的实验状态机，也不为历史 Runtime 版本提供精确复现保证。报告失败不应改写 CandidateRun 的 outcome；失败诊断保留原任务和草稿排查路径，未经发布校验的草稿正文不能作为正式结论。报告中应明确 baseline、candidate、证据缺口和 cleanup 状态。

## 文件与兼容边界

TaskCase 通过 case.complete 发布，缺少标记的半成品不能作为完整场景。可选历史终稿封存在 `baseline-artifacts/manifest.json` 与配对的 `baseline-artifacts/files/<bundleId>/…`；旧 Case 无清单时由 attempt `derived-history/` 补证，不写回已发布 Case。Experiment 使用自身的日志与文件协议，不能套用 Case 标记。只读 History 不申请 writer 锁、不改写日志；未知 schema 和完整坏行需要诊断，不能跳过坏行拼出完整轨迹。持久化 compare 与历史摘要依赖 record.json；Store 能 replay 不证明记录文件丢失时应用会自动重建。

进入模型的正文先经过秘密过滤，再持久化并发送；超出内联预算的内容使用带 hash/长度的附件，重建时校验。Pi 内存 transcript 不是另一份持久化真相。角色工具读取的正文同样需要可复原的事件／附件记录，仅保存可变文件路径或 digest 不足以重建输入。

Comparison 每次使用独立 attempt。新提交路径的定向调查与创作复用同一 Session；首次审阅前关闭该 Session，以同 attempt key 创建没有此前对话的新 Session，后续审阅修正复用该新 Session。旧直接报告端口仍保持连续 Session。新提交路径按定向调查、提交、审阅三轮推进；首轮先读取确定性 briefing 索引，只追查会改变结论的问题。`comparison.phase_completed` 记录每段耗时、模型请求、工具调用、压缩和预览次数；旧四轮 JSON 信封仅保留给旧端口。可执行 Prompt 以 [`comparison-agent.ts`](../../src/agents/comparison-agent.ts) 为唯一文本源：以任务成功标准选证据形式，点名 `render_artifact` / `register_evidence` / `preview_report`；截图与页面查看只走这两个受控工具，禁止经 `shell_exec` 启动 Chrome/Edge/Firefox 或做 `--version` / `--dump-dom` / 用户 profile 探测；渲染失败则记录 limitation 并继续文本证据，不得用等价浏览器 shell 重试。Prompt 是第二道防线，不能替代 Comparison 工具装配层的 shell 边界。提交时 Host 检查短引用、媒体、结构和安全内容；review 须预览且改稿后重检。取舍见[草稿提交与版本发布](../decisions/accepted/2026-09-26-comparison-draft-publication.md)与[禁止直接浏览器 shell](../decisions/accepted/2026-09-20-comparison-prompt-no-direct-browser-shell.md)。Host 持有确定性指标和模板区域，Agent 写本次任务的差异与判断；未知 token、价格或用量不是零。候选 snapshot 缺失或不完整时明确 unavailable，不能悄悄改读可变运行副本。

新审阅首轮得到原 context 的导航，先从文件读取原任务、决定性来源及实际 report.html；saved findings 只作为尚未验证的语义假设与问题历史，不能替代来源。工具、catalog、draft、阶段状态、审计与资源 tracker 仍属于同一 attempt，模型请求、工具、累计费用和开始时间不因换 Session 重置。创作失败不创建审阅 Session；attempt级取消signal跨会话存在，cancel与进行中的release先取消attempt再关闭当前缓存Session；旧Session关闭空档中取消也不创建付费review，新Session图片交付权限从空集开始，不继承旧Session图片。取消与release指向当前缓存的新Session，返回的 sessionId 来自实际审阅，模型输入仍逐请求审计。换会话本身不增加审阅轮数或并行模型调用，也不放宽预览、digest 与原生图片交付要求。

旧 attempt 可通过 `recover-comparison` 离线复核：只读冻结 context、catalog revision、预览事件与原草稿，重新运行当前校验器。缺失预览、digest/revision 不一致或校验失败不得恢复；`--publish` 是显式操作且拒绝覆盖已有根报告，成功后追加恢复事件，不篡改原失败事件。

默认新路径以一次定向调查进入创作与审阅；旧四轮端口仍保留阶段边界。调查按下一项检查能否改变取舍、证据强度或重要限制决定是否继续，不把调用次数当成充分理解的标准。可配置 `AgentBudget.comparisonResources` 另提供调查软预算和整体硬保护，生产工厂默认调查 12 次模型请求 / 30 次工具 / 120 秒，整体 40 次模型请求 / 120 次工具 / 600 秒，不默认启用金额上限；调用方传入 `comparisonResources` 完整替换默认值，`{}` 关闭这些保护，复杂任务须显式调高。软预算限制继续调查，但允许保存带限制的发现并完成创作审阅。硬保护或取消不发布无效草稿，不覆盖旧成功报告。Pi 的生成与压缩分别审计实际模型请求和 `agent.usage_reported`；阶段与结束事件记录资源。金额保护基于已返回 usage 和价格估算，缺失时拒绝继续，不能精确限制在途费用或替代供应商账单。协议见[关键发现与资源保护](../decisions/accepted/2026-10-05-comparison-scoped-findings-and-resource-protection.md)。

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

Comparison复审扩展调查独立累计并复用调查软额度，repair不重置；整个attempt剩余<=6请求、<=20工具或<=90s时保留收尾资源，拒绝进一步检索/渲染/登记，允许findings闭合、修稿和精确digest预览，硬限仍生效。每个新草稿端口的工具结果附phase、剩余额度和草稿/预览绑定，经标准工具结果审计复原。额度或结构有效不认证语义，未核实决定性结论必须撤回保证或明确不可判断，不发布旧预览兜底。旧直接端口与空资源override保持兼容。

Comparison的read结果现在只将实际存在的available/truncated/offset/byteLength/returnedBytes/totalBytes/nextCursor白名单投影到模型可见hostProgress.readCoverage；类型不符或缺失不补造false/0，不透出物理路径/任意details。读取覆盖描述本次返回范围，不保证原运行完整记录；模型不能因正文很长猜测截断。该反馈与原工具结果一同审计/压缩/恢复，文本和原生图片工具实际块均可见，旧直接端口不受影响。

Comparison 的 `quote_evidence` 只读取当前 catalog 的已登记文本引用，并从实际 UTF-8 字节生成带 ref、完整来源 SHA-256、字节范围及全文/节选标签的固定 HTML。原文展示复用该组件；派生解释不能冒称原文。提交、预览、发布和离线恢复重读安全 mounts 并核验组件，不因先前工具成功而跳过来源变化检查；有组件却无法验证则拒绝，无组件的旧报告保持兼容。工具尊重 allowModelText，拒绝二进制、非法 UTF-8、越界或切断多字节范围以及超出 16KiB 输出的请求，不静默截断。该能力认证引文字节和范围，不认证自由文字中的事实、判断或完整性；这些仍须语义审阅。
