# 证据、持久化与 Comparison

历史交付可以通过 `capture-history` 显式增补。v1 保留日志重建；v2 表达捕获文件、精确 Git 终点或用户替代基准。独立选择绑定 case/source 与 manifest hash，不覆盖冻结 case；新 attempt 校验后物化自己的 finals，并记录 `comparison.historical_delivery_prepared` artifact/事件，旧报告重开不读取新选择。替代品不是原件，终点不进入候选起点。契约见[历史交付采集决策](../decisions/accepted/2026-10-14-historical-delivery-capture.md)。

冻结 observations 的 `event-timeline/` 提供历史/候选事件索引、100条分页、原始 JSON 与相邻记录，`COVERAGE.txt` 标明选定范围及预览截断。完整索引不等于工具搜索不截断，片段无命中不能证明没有执行；正文判断回到原始载荷。

## 事件日志与文件

每个 Experiment 目录由 [`ExperimentStore`](../../src/infrastructure/store/experiment-store.ts) 管理：`events.jsonl` 追加事件，`writer.lock` 保证单写者，`runs/<runId>/attempt.json` 和 `manifest.json` 通过 `writeImmutableJson` 保存不可变快照，artifacts 旁有 manifest。Store 重开时会读取并校验事件；只读打开不改日志，取得 writer 锁后才按字节截掉不完整尾行，保留完整事件的原始字节。这提供 replay 能力，不等于应用启动会自动安全续跑未完成实验。

事件有 sequence、eventId、type、可选 runId/operationId、payload、occurredAt 和 checksum。提交请求入队时先取得与 JSONL 一致的 JSON 快照，追加前总是校验 `EventEnvelopeSchema`；对 Controller、Comparison、候选用户可见 turn 等已登记事件再校验专用 payload schema，未登记 type 不会获得额外的通用 payload 结构校验。Store 持有的已提交事件深度冻结，追加返回值、订阅参数和 `events` / `eventsSince` 的元素都不能改写日志事实；读端只复制结果数组，不重复深复制全量 payload。重复 operation 在相同 type/run/payload 时幂等，不同数据会失败。去重范围仍是整个 Experiment；run 所属操作由各自写入者从 runId 与局部 ID 派生独立、有界的 operationId，旧事件原样重放，见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

持久化边界使用 `Value.Check`：RunAttempt 必须先于 RunManifest；模型输出、外部 JSON、artifact manifest 和比较 briefing 经过对应 schema。Artifact manifest 的 schema 位于 core；Store 读取时校验版本、owner、ID 与路径，读取正文和幂等重试还校验长度/hash。成功 artifact 必须有与 `sourceEventId` 对应且归属匹配的 `artifact.created`；同内容但缺事件的残留也拒绝自动补提交，不覆盖原文件。并发 artifact 提交由 Store 串行处理。细节见[Artifact 提交事实与磁盘内容一致](../decisions/accepted/2026-09-23-artifact-commit-integrity.md)。实验没有生产 `experiment.complete` 标记；有效性由实际 spec、attempt、manifest、日志和读端规则决定，不应虚构该文件。

Recovery 的固定 artifact 与决定、诊断等不可变 JSON 按 `runs/<runId>/` 保存；默认 Recovery Provider 的 baseline 按 `environment/recovery/<runId>/` 隔离。baseline marker 的 `reportRunId` 指向 run 所属报告，旧 marker 缺字段时只查实验级报告；旧 scene 缺 `recoveryProviderRunId` 时继续使用 `environment/baselines/`。旧根级文件不迁移、不覆写，新读端按明确 owner 读取，不能用另一 run 的同名 artifact 填补缺失。

## 冻结任务保全

共享冻结入口不删除或重写任何已有 case 目录。当前新冻结写入显式版本 2；统一读端支持版本 1 和 2，未知版本拒绝。旧版本保留原 ID、hash、路径与起点，不自动升级或补认证。损坏、缺完整标记或同身份内容冲突均保留旧证据并明确拒绝。历史列表只统计非法 case，执行读端暴露诊断。

v2 的 `provenance.sourceHash` 表示脱敏后来源字节，`contentHash` 是 `task-case-v2` 算法对任务内容与保留文件清单的 SHA-256；`caseId` 为 `case-v2-` 加 digest 的前 32 个十六进制字符。同来源不同起点、执行/授权、有效隐私条件、解释版本、证据或文件字节变化形成新身份，可以并存；只改变 importedAt、来源存储路径或 casesRoot 不改变身份。排序对象键但保留消息和事件顺序；正文及 taskContext 中有任务语义的路径保留。自身 caseId/contentHash 和 case-owned artifactRefs 的 caseId 不参加递归 hash。observations 元数据分别提供 case schema/identity 算法和 sourceHash/contentHash；逐消息 source refs 仍使用原行内容 hash，不把 case digest 当作来源行 hash。

v2 读端校验 schema、身份、内部 owner、每个清单文件长度/hash，以及封存 artifact manifest 与绑定文件的关系；私有 case 拒绝清单之外的文件，发布输入也必须准确匹配清单。case.json 必须是常规文件；case root、私有 casesRoot 及绑定文件内部路径不允许 junction/符号链接。配置的数据目录及其上级由操作者选择，不宣称阻止恶意同权限进程替换整棵父目录。显式外部 `--task-case` 可以读取无发布标记的完整 JSON 与绑定文件，但同样要求真实 case root，仅复制清单内文件而不认领外部根的其它文件；读端保存进程内 origin receipt，重新持久化时复制绑定文件并在私有 staging 再核验，不能把旧校验当作后来复制字节的证明。

目录发布先取得同身份的文件系统独占 nonce 租约，失败/并发等待有界，不自动清未知旧锁；再沿用私有 staging、完整标记与 Windows 有界 rename 重试。释放前核对 nonce 和文件身份，替换后的他人租约保留。正常同内容并发幂等，冲突拒绝；读者只列出已发布完整目录。不迁移旧数据，不认证模型语义或新增断电持久性承诺。理由与兼容边界见[版本化冻结身份](../decisions/accepted/2026-10-14-frozen-case-identity.md)。

文件发布原语统一位于 [`identity.ts`](../../src/core/identity.ts)：`writeAtomic` 替换可变投影；`writeImmutable` 和 Store 的 `writeImmutableJson` 创建不可变事实，先写完并关闭同目录私有临时文件，再用 hard link 原子创建目标。目标已存在即拒绝；不支持 hard link 时不回退到覆盖写。失败只清理本次临时文件，清理失败保留原错误及已发布状态；成功发布后不回滚目标。低层不判断内容幂等，schema、owner 与同内容重试仍由各提交边界负责；不新增断电持久性承诺。文件原语不能用于目录发布。理由见[不可变文件无覆盖发布](../decisions/accepted/2026-10-14-immutable-file-publication.md)。

候选启动在首次实验事实写入与工作区准备之前取得 writer，RunAttempt 成为接纳点；构造前终态使用启动失败协议，详见[执行与结果](./execution.md#candidaterun-生命周期)。Store 的启动/清理补充事件同时校验 schema、envelope owner 与已提交 attempt 的 case；writer lease 读写使用 core schema，锁无法读取、解析或确认合法身份时保留原锁并报告失败。释放只处理本次 owner/nonce，不删除替换 owner 的锁；关闭与 flush 错误不能相互覆盖。

## 运行与报告归属

首页与历史列表使用 v2 轻量查询：实验 `modelInputAudit: not_checked`，空间 `storageSizeStatus: not_collected`，数值缺失不代表零。列表仍核对提交前缀和运行/报告归属；冻结 case 的元数据读取保留真实目录、普通 JSON、完整标记、owner 和内容描述校验，`filesVerified: false` 不认证绑定文件。打开任务详情才完整校验冻结文件，打开实验详情只审计所选实验的模型输入；独立空间统计返回采集时间。条目 I/O 错误和日志前缀诊断保持可见，读取并发有界、过期导航不回写页面。旧完整查询仍供显式审计使用。见[列表与显式审计](../decisions/accepted/2026-10-15-history-listing-and-explicit-audit.md)。

固定身份的实验轻列表另标 `taskCaseFilesVerified: false`，只确认元数据描述与固定身份一致，不读取绑定附件或认证它们的现存字节。所选实验详情使用完整 reader，只有 v2 完整冻结绑定且文件验证成功才置 true；旧 v1 没有完整绑定清单，详情读取成功也保持文件未认证，失败则保留原 run 与诊断。任务使用和重比仍须执行其格式支持的完整验证，不能根据轻列表的标题或 fixed-v2 标记跳过文件检查。组合边界见[固定身份与有效总预算](../decisions/accepted/2026-10-15-remediation-integration-boundaries.md)。

新 ExperimentSpec v2 只绑定固定 TaskCase 身份：冻结 v2 case 使用完整内容 hash，旧 v1 使用旧 hash 和仅忽略 importedAt 的当前 canonical 观察。旧 metadata（无版本或版本 1）完整校验后原样读取，不重写、不补历史认证；History 明示旧身份未认证。新的当前绑定与保留 case 不一致时显示具体诊断，不展示替换内容的标题。候选、policy 和 Agent 实际配置仍属于每个 run，首轮配置不是永久约束。

metadata 与 preflight 读端分派 missing/corrupt/unsupported/legacy/current；非正整数版本为损坏，合法未知版本为不支持。新 preflight wrapper 绑定 experimentId/runId 并完整校验嵌套内容；只有 nested missing 可读旧根级文件，损坏或未知版本不能回退。缺失旧预检的运行重比明确 sourceBaseline unknown 与证据限制。固定场景和接纳顺序见[固定实验身份决策](../decisions/accepted/2026-10-15-fixed-experiment-identity-and-persisted-comparison-context.md)。

对已结束 RunRecord，inspection、模型可见运行事实与 Target 引用只读 record.trace 的原日志窗口，后续同 run 的 runtime 追加不能改变旧答案、usage 或 settlement；无 record 的运行中查询保持读取当前日志。

启动失败仅按 core schema 与已提交 attempt owner 匹配的 run.startup_failed 显示 failed/cancelled、stage 和诊断；没有 experiment.json 时保留最小身份与 missing_metadata，孤立失败文件不认证。已接纳 attempt 的任务与固定实验元数据冲突时，History 保留真实 attempt 任务和启动诊断，并显式展示原元数据任务 ID 与冲突。元数据缺失或损坏且事件日志发生 I/O 错误时，列表保留损坏条目、unknown 和安全错误码，不生成运行事实；打开详情仍报告实际日志读取错误。

History 的默认运行按已提交 `run.attempt_created` 顺序选择，日志校验后再按选中 run 重建模型输入及终态，另一 run 的完成不能补成当前 run 的完成。缺少该 run 生命周期日志的旧运行按经过 schema 和身份校验的 attempt/record 时间排序；其他 run 或后续 Comparison 事件不改变其旧格式资格；缺有效时间或最新时间并列时只给确定性的选择并标 `runOrdering: unknown`，不宣称时间上的最新。重比默认倒序查找合法 finished RunRecord；多条 legacy 的时间未知或最新并列时必须显式选 runId，唯一合法 finished 仍可默认选择。显式 runId 精确选择且不回退。record.attempt、manifest.attempt 与已提交 attempt 必须一致；该 run 存在生命周期日志时还须匹配已提交 run.finished 的运行事实，不能以孤立 record 认定完成。已提交 artifactRefs 保持原值和顺序；无本 run 提交锚点的旧 record 仅接受精确本 case 或本实验/本 run 的单 owner refs，跨 run、双 owner 与未绑定 run 的引用拒绝认证；仅允许额外一个精确属于本实验、本 run 的 host-trace.json，并须对应晚于 finished 的 artifact.created，实际读取仍校验 Store manifest、提交来源与 hash。

每次 Comparison 将最终发布 HTML 保存为实验根目录下唯一的 `report-<attemptId>.html` 或 `comparison-failure-<attemptId>.html`。这些文件与便利投影同深度，保持内容寻址 media/evidence 与 attempt 独占 historical finals 的相对链接；最终发布模型另存在 attempt 的 `published-report-model.json`。`comparison-attempts/<attemptId>/result.json` 经核心 schema 校验，绑定 experiment/run/attempt、invocation、相对报告路径与完整 SHA-256。只有匹配的已提交 `report.created.reportOwner`、此前完成事件、owner 清单及实际文件 hash 都成立才确认归属；无提交、错配、损坏或逃逸路径不采用根级文件补缺。失败重比只展示当前 run 的诊断及该 run 的此前成功报告。

根级 `report.html`、`comparison-failure.html`、`comparison.json` 仍供既有工具访问，但只是可替换便利投影。旧格式缺 owner 的报告可打开，History 标为 unknown/unconfirmed；不迁移旧字节，不将根级 completed 归到当前选择。协议取舍见[运行与报告归属](../decisions/accepted/2026-10-14-run-report-ownership.md)。

结果页与 History 共用最小只读展示输入；unknown/pending 是合法展示事实，不构造不存在的 Session、报告或 Agent failure。应用层在既有 comparisonDetail 中保留实际 value.status（包含 completed），缺失详情不作为成功的缩写。失败诊断仅展示已保存的 token；报告路径与 owner 继续由上面的查询协议决定，展示层不补造。取舍见[诚实的结果展示输入](../decisions/accepted/2026-10-15-honest-result-presentation.md)。

## 模型输入可追溯

默认 Pi Harness 为每次 Candidate、Recovery 与持久化重比提交版本 1 的有效配置 DTO：先提交 run-owned 配置 artifact，再写 `harness.configuration_bound`，其中保留同一配置正文、hash 和 owner 引用。该事件先于本操作的连接 probe；artifact 残留不能认证配置。RunManifest 的角色配置、Recovery initialize 记录和 Comparison 操作绑定准确引用；重用 Agent 或连接检查缓存时仍提交本次 owner，引用不写回共享 Agent 实例。自定义 Port 与旧记录缺有效引用时保持未记录，不从 requested budget 推断已经生效。

快照区分 Controller 单次无限、Recovery 的实际单次上限与操作总限，以及自主 Comparison 配置单次上限、整体截止和逐请求 `min(剩余整体时间, 单次上限)` 规则。内置 Recovery 的两项预算使用本次 recoveryBudget.callTimeoutMs；整体计时、配置绑定前后及显式冲突边界见[Recovery 预算](./recovery.md#recovery-agent-单任务会话)。空 Comparison resources override 保留默认整体截止；未在自主模式执行的旧阶段限额只放 requestedResources，不冒充 enforcedResources。快照与 Agent 构造共用预算解析，Candidate/policy 以及 Pi 私有配置、首次解析模型使用冻结副本，后续调用方对象或模型注册表变化不能改写本次执行条件。

模型 DTO 显式挑选 provider/model、API、上下文和输出窗口、输入能力、reasoning/effort、已知无敏感标量 compat override 与已安装 SDK 版本。嵌套 schema 拒绝未知字段；不展开本机配置，不保存 apiKey、keyRef、headers 或 endpoint。SDK 按 URL 推导的默认 compat、复杂未记录参数和网络路由明确不完整；fingerprint 仅供比对，不能重建这些内容或凭据。此 DTO 记录 Harness 可控制条件，不宣称完整重建 Provider wire 请求；普通 generation 的实际输入仍以 Host 快照为准。

`harness.probe_requested` 在每次实际 outer 调用前保存版本化模板、实际 timestamp、reasoning 与配置引用，结果事件只保存通过、空响应、失败或取消分类。连接检查最多三次 outer 调用，每次允许 Pi SDK 内部重试；日志不虚构 SDK 未公开的各次传输。请求审计失败不调用模型；传输与完成审计同时失败时保留两者，成功响应后的审计失败也不标记连接验证成功。连接验证缓存包含凭据变更，Agent 缓存另包含 locale、budget 与 recoveryBudget。

持久化重比先在 writer 下保留 `comparison.started` attempt，再初始化 Harness。准备/Host 失败保存该 attempt 的不可变 `operation-failure.json`、版本化 `comparison.operation_failed` 和失败/取消完成事实，不挤入候选启动协议，不伪造 Comparison Session。History 显示当前 attempt 失败并保留同 run 此前确认报告。只有明确连接 probe 来源才归为 Provider 失败，配置绑定/磁盘/审计失败保持 Host 初始化失败。

Controller、Recovery、Comparison 都通过 Agent Session Host 生成模型请求。Host 把 system prompt、用户消息、工具结果和结构化结果写入审计事实；普通 generation 另保存 Pi 转换与裁剪后、经过凭据脱敏的实际上下文快照，保留原生工具参数及 SDK 拒绝消息；[`model-input.ts`](../../src/infrastructure/agent/model-input.ts) 从事件日志重建请求。上下文压缩必须追加 `agent.context_compacted`，其中 summary 与 retained tail 是后续请求可见的输入来源。新增模型可见事实必须先写入事件审计（必要时再由 briefing 做可读投影），不能只存在内存变量。

压缩请求另在 `agent.model_request` 的 `compactionInput: AgentTextBody` 保存实际上下文，仅含 systemPrompt、messages 与 tools；经同一秘密过滤的上下文用于审计和发送，不保存 Provider 凭据或只留不可重建的 digest。大正文沿用附件溢出、字节长度与 hash 校验，图片记录为不可变附件引用，不把 base64 写入日志。History 重建可返回独立的 `compactionRequests`，不将压缩混入普通生成请求；历史缺输入体标记 contentComplete=false，附件缺失、损坏或图片校验失败保留不完整与诊断，不把压缩后的 summary 当作压缩请求原始输入。

generation 快照沿用版本化正文、不可变附件、字节长度/hash、图片引用及 schema 校验。重建明确区分快照与旧事件投影；旧日志的 `contentComplete` 只表示已记录正文和图片可读取，不能证明完整上游输入。新独立复审的 live 发布与离线恢复只依据实际 generation 快照核对完整当前 inspection；仅有旧投影与 digest 不足以认证。Provider 配置和认证凭据不属于快照，原始请求 digest 也不等于脱敏/图片引用快照的字节哈希。

TUI 读取这些事实并投影状态。它不持有 CandidateRun 状态机，不展示未公开的内部推理，也不把模型输出未经 schema 校验地当成事实。

History 从已校验的提交日志前缀构造只读附件读取器，每个 Session 按起始事件的 runId 绑定正文和图片读取范围；复用 Store 的 manifest、owner、提交事件及字节/hash 校验。完整图片记录不标成内容缺失，缺失或损坏附件保留诊断并标记输入不完整。此路径不创建目录、取得 writer lock 或改写未提交尾部。

## Comparison attempt

Comparison 正式工具与 coding 试验复用受管 `exec_command` / `write_stdin` / `cancel_process`：默认等待 10 秒后返回状态，等待结束不终止进程；进程绑定当前 Session/invocation，成功结束前必须完成或取消并确认收尾。命令非零结果与可纠正前置拒绝不等于 Agent 致命失败，审计、日志持久化及终止不确定仍阻止成功发布。命令包装保留 owner、生命周期与浏览器限制，日志归属当前运行。工具及命名兼容决定见[受管进程与会话名称](../decisions/accepted/2026-10-15-comparison-managed-processes-and-session-names.md)。

报告对外只区分历史与当前，模型标签分别来自历史证据和当前运行的实际解析模型；分析模型另列，不能填补当前模型缺失。内部 candidate/baseline 字段及旧报告字节不迁移，原始引文不作术语替换，Token 聚合和计价口径不变。

Comparison 的共享 Context、Port、Result、Facts 与输出校验由 [`comparison-contract.ts`](../../src/agents/comparison-contract.ts) 持有；应用、脚本和默认自主实现直接依赖该中立模块。旧 ComparisonAgent 内置 executor、阶段策略和兼容 re-export 已退役；历史 schema、reader、已提交报告认证及注入历史协议 Port 继续保留。共享不变量迁移与旧策略退役清单见[执行器退役决策](../decisions/accepted/2026-10-15-comparison-executor-retirement.md)。

默认自主 Session 的输入以用户需求和实际交付物为先，完整导航与过程材料按需展开。`render_artifact` 支持一次调用中重放受控点击、表单输入、按键、滚动、等待和 DOM 状态观察，加载前可设置弱动效和主题偏好。每次新开冻结页面，传完整动作序列；带动作的帧时间相对序列完成，观察对应其动作位置。工具回执记录动作、条件及观察，沿现有审计和测量分页保存；不开放任意脚本、任意网址或用户浏览器。初始和工具后的剩余时间与实际整体截止保持一致。见[交付优先与浏览器检查](../decisions/accepted/2026-10-11-comparison-browser-actions.md)。

默认由 [`AutonomousComparisonAgent`](../../src/agents/comparison-autonomous.ts) 执行单个自主 Session、一个初始任务 prompt。模型自主调查、验证、编写、预览及修订；read/search、write/edit、shell、受控渲染、图片读取/变换及证据登记工具全程可用，独立只读工具仍按已有声明并行。没有强制 understand/investigate/compose/review 阶段、周期语义保存、独立 reviewer 或 findings/disposition 提交要求；文件工具把原始交付作为只读挂载，工作文件写入 scratch/。模型选择证据与判断，Host 不对任务语义增加专用判题规则。

Shell 的只读命令 guard 仅提前阻止已知写命令，不是 OS 文件权限或沙箱；例如 echo 重定向不在当前识别范围。报告 Host 区 fingerprint、引用 hash 与预览绑定校验只约束报告及实际引用证据，不提供整个文件系统的写隔离。具体回归边界见[当前路径决策](../decisions/accepted/2026-10-15-comparison-current-path-regressions.md#shell-回归的验证范围)。

Host 指标固定在已审计的自主 Session system prompt，压缩摘要丢失指标时，后续实际请求与 History 重建仍可取得原值。当前 Port 的 completed 结果必须实际具有 `reportPath=report.html`；assert 不通过临时副本替调用方填充字段，旧历史 envelope schema/reader 继续兼容原记录。见[指标输入与结果断言](../decisions/accepted/2026-10-15-comparison-pinned-input-and-result-validation.md)。

`submit_report` 从 scratch/ 读取 UTF-8 证据片段，另提交推荐、必要边界及最多三条差异，复用安全 shell 和原有来源验证。新报告 formatVersion=3：突出历史/当前实际模型，推荐最多80个非空白码点、每条差异60、全部作者正文900，含表格/图注/代码；不提供详情展开区。Host 生成耗时、Token（k）和估算费用三行表，未知不作零，计时来源或覆盖不一致时短句提示。完整视口图优先、裁剪保留来源，长页沿受控滚动观察，视口图不等于全文。接受后须 `preview_report` 当前 digest/catalog，实际回执进入同 Session 后续 generation 快照并正常完成才可发布。新 `comparison.requested` 标记 `autonomousContractVersion=2`，旧1及报告1/2按原契约恢复，不与独立复审标记混用。版本完整性不认证语义或审美，见[紧凑报告决策](../decisions/accepted/2026-10-14-comparison-compact-report.md)。

默认 Comparison 仅有整体 24 小时预算，不默认限制请求数、工具数、费用、来源阶段时间、保存累计耗时或续查次数。自主模式的空资源 override 也保留默认整体截止；显式请求/工具/费用限制仍执行，但不引入阶段截止。每次调用使用整体实际剩余时间与单次调用 timeout 的较小值。取消、数据授权、工具大小和并发容量及发布完整性检查继续有效。详见[整体时间预算](../decisions/accepted/2026-10-14-agent-default-budgets.md)。

## 历史多阶段协议与共享兼容

旧内置阶段执行器已退役。以下多阶段、独立审阅、findings、inspection、decisionSummary/disposition、周期 source-save 与字符配额保留退休前的协议背景及历史恢复认证要求，不提供可构造的旧内置 executor，也不提供仍可启用的阶段配额模式。旧请求仍按原标记验证，不自动降级成自主模式。共享的授权、证据、原生图片、审计、有限 Shell 命令检查和原子发布规则继续适用；段落中的旧“新流程”“生产路径”只指对应历史协议。

严格三会话路径向模型提供单一 schema 的 `update_comparison_findings_delta`，专用端点允许省略重复 `kind`，由 Host 补为 delta 并校验；通用工具仍要求原判别字段。范围字段允许字面标签名且在报告中转义，仍限制非空单行、长度及数量。delta 的 `addedFindings` / `addedQuestions` 可新增观察或问题；已有每个 ID 仍须完整且恰好一次 retain/replace，新增不能覆盖旧身份。Host 根据真实当前记录合成 canonical submission，继续经过原 `Value.Check`、来源及 catalog/findings 绑定校验，不补造语义内容。完整工具保留兼容，两个名称在全部阶段、完成回调和副作用入口服从相同守卫。

正常调查和独立来源审查每6次来源工具后在完整 turn 边界进入只准保存的窗口，禁止读取、渲染、登记和其他副作用。只有真实 accepted 且当前实际非空 saved state 匹配才可继续；pending 保存可回到下一来源批次，不能冒充 ready，ready 才可结束该调查。每个阶段最多5窗口，Session、累计资源和绝对截止不重置：默认1200秒总额下调查来源保持240秒绝对截止，中途保存共享累计120秒实际保存额度并保护后续完整作者窗口，恢复来源不续期；独立来源初查限240秒，复审保存使用独立且不重置的截止，并受整体收尾预留限制。下述 `independent_findings_pending` 指来源完成边界，窗口内 accepted pending 本身不立即结束来源阶段。旧端口保持兼容，有限收尾、稿件失效和实际核稿/inspection/preview要求不放宽。见[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

SDK 参数校验拒绝可能发生在 Host 应用工具入口前，仍通过既有安全 called/failed 工具事件计数；新审计只记录工具身份与拒绝类别，不复制整份无效参数或 SDK 回执。模型可见拒绝继续由脱敏 generation 快照复原。拒绝不代表应用工具执行成功；审计失败保持 fatal。增量保存及有界窗口不构成实际模型性能或稳定性验收。

新草稿生产调查通过同进程 `hasSavedFindings` 读取 discovery 的真实接受状态。首次 snapshot 接受前，调查执行边界拒绝 shell/render/register，read 与导航按原预算开放，模型须先保存最小完整的任务标准、双侧 final（未知可 unavailable）、空或实际 findings、pending 问题与 nextCheck；非法更新与口头承诺不能解锁。接受仅解除首次检查点，pending 与旧 catalog 仍不能 compose；重要检查后提示要求完整替换并保留问题历史，不新增独立阶段、不重复扩大工具结果。closure 与独立 source pass 按后述严格路径分配截止或旧端口兼容规则推进，整体硬保护和取消先检查，旧无 getter 端口保持兼容。见[首次 findings 检查点](../decisions/accepted/2026-10-05-comparison-first-findings-checkpoint.md)。

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

兼容 format 2 报告以独立结论区突出判断，随后紧凑展示时间、估算费用与 Token 总量，再呈现关键差异；仅 Token 分项默认折叠。初始结论、比较正文与可选详情槽位留空，组件原型只在不可见的 `<template>` 内提供结构，不预填赢家、差异数量、核验标签或媒体引用；已登记媒体仍在 Host 目录中供 Agent 选择，不自动配入正文。Agent 按任务组织实际差异、用户影响、必要证据及重要未知，省略不用的组件。旧整页草稿的缺失内容修复与限制说明继续兼容。当前 format 3 不设详情区，见上文[Comparison attempt](#comparison-attempt)。历史理由见[空槽位与结论优先的报告骨架](../decisions/accepted/2026-10-14-comparison-empty-report-template.md)。

Host metrics 的 `data-metrics-layout="compact"` 标记与区域顺序不变；旧无标记的正文先于指标布局和四字段指纹仍可读取，不重写旧报告。时间保留分秒，极小正费用显示 `<0.001` 美元，避免舍入为零。费用说明价格快照、非供应商账单和工具费排除，Token 分项可能重叠或缺失，不能直接当作跨工具效率评分。证据链接具有可见样式与键盘焦点，配对图片按自然比例显示；窄屏将双侧证据纵向排列，不强制表格的桌面最小宽度。

候选 Token 与单模型估算费用仅聚合 `runtime.` 事件，再按候选 Runtime 模型定价；同 run 的 Controller、Recovery、Comparison Agent 用量不计入候选指标，重复比较不得改变原候选成本。没有 Runtime telemetry 时保持未知，不借 Harness 用量补齐。Comparison 开销仍保存在该 attempt 的独立资源记录；新检查从原 journal 重算，不原地改写旧报告或冻结 facts。见[Runtime 用量归属](../decisions/accepted/2026-10-06-runtime-usage-attribution.md)。

价格继续手工维护在 [`pricing-catalog.json`](../../src/application/pricing-catalog.json)，运行时不联网更新；修改目录须更新版本并验证实际模型独立命中。2026-10-15 版本保留既有 cc-switch 条目，补充 GPT-6 Sol、Luna 和 GPT-6.1 Sol，来源为当日 [models.dev API](https://models.dev/api.json) 的 `openai` 条目，标记 `models-dev-snapshot`，四项费率采用其基础档。该档是第三方公开参考估算，未获 OpenAI 官方价页独立复核；不涵盖上游 272k 长上下文阶梯、代理加价折扣、分时计价或订阅分摊，不能据此还原历史实际账单。私有渠道可使用操作者覆盖；未知价格保持未知，已有报告不因目录更新而重算。

Agent 区的内联 `style` 属性和原生 `dialog` / popover 浮层一律拒绝，避免遮盖 Host 的任务、模型与指标。

Host 双侧会话标签同时显示日期（UTC）：格式3置于模型名下方，以次要文字显示；格式2置于会话标签内，共用日期格式化逻辑。历史侧取 `taskContext.historyStartedAt` 与历史事件顶层 `timestamp` 中最早的合法时间，当前侧取 manifest 开始时间，缺失或非法时退回 attempt 创建时间；不使用导入时间、文件修改时间或报告生成时间。日期冻结在可选 `reportFacts.sessionDates` 中，沿现有 `comparison.requested` 输入 artifact 和 briefing 审计链保存、恢复。旧 facts 缺字段时显示“日期未知”，旧已发布报告不原地重写；日期仍由 Host 所有，不能由 Agent 推断或改写。日期不代表模型版本或能力变化。取舍见[双侧会话日期](../decisions/accepted/2026-10-14-comparison-session-dates.md)。

## 报告发布

当前自主报告由 `submit_report` 接受 fragment，按当前 digest/catalog 预览并将实际回执交付后续 generation；正常完成与未取消仍是发布条件。最终不可变报告、owner 认证和根级便利投影的路径与规则统一见[运行与报告归属](#运行与报告归属)，不把可替换的根级文件当作归属证明。

### 历史草稿发布与恢复认证

以下为旧整页与 format 2 草稿的协议；其中的工具、独立审阅和字符配额不属于当前自主工具面。旧日志仍按原标记检查，不因执行器退役而跳过认证。下文“根报告”指对应旧发布布局；当前新增报告按上面的 owner 协议保存不可变文件。

正式报告是 experiment 根部的 `report.html` 及其媒体。新流程用 `submit_comparison_draft` 接收 category、headline、comparisonHtml、可选 detailsHtml 和证据不足状态；Host 即时校验并生成完整页面。模型文件工具不能直接改写新流程的 `report.html`，自定义旧端口仍可按旧整页契约写 attempt 草稿并接受末尾发布校验。新流程仅在草稿完整校验通过、当前 catalog revision 与草稿 digest 均匹配成功 `preview_report`、审阅调用正常完成且未取消时发布；末尾自由文本为空不阻止有效版本发布，也不表示模型作过最终质量确认。`publishComparisonArtifacts` 先把被引用媒体拷到内容寻址路径（`media/<hash>.…`）并校验，再写审计 `report-model.json`（含 `formatVersion: 2` 与 `comparison` / `details` slots；旧四区 model 仍可读），最后原子替换根 `report.html`。失败或取消不得覆盖旧成功报告仍引用的资产。

`inspect_comparison_draft` 为审阅返回当前已接受报告的实际 Agent 内容和版本绑定，省去整页 CSS；文件 digest、catalog 或 findings 绑定变化时不可用，无已接受草稿的旧端口也明确不可用。该读取走现有工具审计，不新增第二份权威草稿，不代替实际来源核对或 `preview_report`。审阅先核实际主张，再批量修订、预览当前 digest 并结束；预算以内的篇幅优化反馈是建议，不要求为了字数反复提交。只有改变任务判断的限制须主文可见，常规来源、缺失编辑历史和指标方法可放详情。

新模型工具提交须声明 `decisionShape`：一个独立决定性差异为 `single_difference`（标题与主文最多 250 字符），多个独立差异为 `multiple_differences`（最多 600）；同一缺陷的证据、后果与重复描述不算多个差异。超限拒绝保留旧已接受版本和预览绑定，不发布新稿。详情不计主文字数，但不能隐藏改变判断的反证。声明是模型的分类，Host 仅验证字数，分类正确性与决定性完整性仍须语义审阅。旧直接端口及无声明草稿继续按原契约读取。

生产提交工具还要求纯文本 `decisionSummary` 与 `decisionBoundary`：前者表达本次任务的实际可用性及用户取舍，后者表达改变判断的重要未知或反例。已有 findings 重要限制时不能交空边界；没有已识别重要限制时允许为空，不自动生成结论。Host 转义后将两者前置到普通比较主文，复用总篇幅、真实 inspection、digest 与 preview 约束，不另存新的报告字段。字段与可见性检查不能认证判断、覆盖完整性或自然语言真实；技术测量不替代任务级结论，压缩不得删去另一个改变可用性的关键维度。见[决策摘要契约](../decisions/accepted/2026-10-06-comparison-decision-summary.md)。

当前 findings 工具的双侧观察还要求 `supportBoundary`，明确实际输出关系、范围、支持阶段、已覆盖与未检实例；中间目标不能凭数学一致性升级为实际交付。当前草稿通过 `decisionBasis`、`conclusionScope`、`findingDispositions` 为每个当前 finding 指定一次决策角色并绑定依据。依据或边界有中间结果、不可得或未检实例时，充分支持声明被拒绝；相关未知按 finding 在主文保留任务标准、涉及侧和局部或未确认性质；完整观察范围进入详情，仍计入原主文与详情限额，重要决策未知必须由 decisionBoundary 留在主文。有条件或未定结论可以正常结束。字段和角色均为模型声明，不能认证完整性或自由文本语义。引用归属、未知或缺失拒绝会给出具体字段位置、提交引用的实际注册侧及最多十二项相关目录，含省略数量；额外目录读取受原阶段资源约束，不承诺不可执行的分页读取；不泄露私有路径，不自动替换引文或认证语义，拒绝不改变 accepted 状态。基础字段 optional 使新 reader 兼容旧记录，旧 reader 不保证读取新支持范围记录。见[支持范围契约](../decisions/accepted/2026-10-06-comparison-support-boundaries.md)。

`render_artifact` 的实际返回附 `renderedCheck`：来源/hash、结果、请求采样时间、实际帧时间/hash 与 viewport；同 PNG、登记失败也保留已发生的渲染事实，不含物理 PNG 路径，不证明视觉查看。该摘要进入原有工具结果审计，可从日志复原。生产 attempt 保留最近 24 条结果及遗漏数供 `inspect_comparison_draft` 在新 Session 读取；同进程历史不是第二份持久化权威，恢复后不可由空列表推断没有检查。摘要明确属于 Comparison 的检查，不能冒作候选 Runtime 检查；当前 Session 图片交付单独从实际交付集合投影，换 Session 不能继承权限。

可选 `geometryQueries` 在每个采样中观测最多 8 个唯一 selector 查询的 SVG line/path 起终点、circle/ellipse 中心/半径点或 DOM bounds。Host 固定采集器在独立 execution world 中运行，局部 SVG 点经实际 `getScreenCTM` 转为 `viewport_css_pixels`；缺失、歧义、无效 selector、不支持及不可测量均明确返回。外部结果经 core schema、16 KiB UTF-8 上限、身份/顺序/时间与点位映射检查。`geometrySample` 随工具正文与 `renderedCheck` 进入原审计，包含独立观测窗口，随后才采 PNG，不能宣称严格同瞬间。数值不证明元素语义、无遮挡、美观或整个动画正确，也不授予图片查看权限；旧调用不带查询保持原行为。见[渲染几何观测 ADR](../decisions/accepted/2026-10-05-comparison-rendered-geometry.md)。

核稿时若接受文件 digest 正确、但 catalog/findings 绑定过期，`inspect_comparison_draft` 返回 `stale` 的实际作者正文、检查事实与历史问题身份，供按独立证据修复；不返回有效 inspection receipt，不满足最终检查、预览、发布或恢复。文件缺失/篡改仍 unavailable。findings 更新是完整替换，历史 ID/question/decisionImpact 不可抹除；缺失或状态错误返回具体修复材料，拒绝不改变已接受记录。历史解决解释不是认证证据，不能自动沿用为独立结论。严格 source pass 允许基于实际查证更新 findings，初始保存记录仅作为待证假设；inspection、submit、write/edit和preview仍拒绝。其他旧端口继续拒绝source findings更新；实际完整草稿只在后续正文检查点取得。

findings 收尾仅允许保存已取得的观察。内置 Pi 在已有 snapshot 且支持 delta 时仅暴露 `update_comparison_findings_delta`；缺少初存或旧兼容端口保留完整更新工具。独立复审 findings 收尾还可包含 `read`，仅允许严格登记的 repair read，在调用空闲并完成 usage 审计后恢复原工具集；原执行拒绝、取消及资源保护继续生效。其他 Provider 可忽略可选暴露参数，不能据传参声称已隐藏工具；实际集合以 generation 快照为准，见[收尾工具暴露 ADR](../decisions/accepted/2026-10-05-comparison-findings-tool-exposure.md)。限制工具列表不保证模型及时保存发现或判断正确。

默认内置路径通过 `update_comparison_findings` 保存任务标准、双方最终来源、观察方法与支持范围、反证、重要限制和判断问题。Host 校验引用归属及结构，不证明自然语言主张正确；不可变发现 artifact 和 `comparison.findings_updated` 绑定 attempt、revision、catalog revision 与 digest，工具回执沿用模型输入审计。问题历史不得静默删除，重新打开已解决问题需新依据。问题须解决或说明证据不可得才进入创作；旧自定义 Comparison 端口保留原契约。

草稿接受版本通过 `comparison.draft_accepted` 同时持久化 discovery revision、catalog revision 与 HTML digest；离线恢复核对最新发现 artifact 与接受绑定，并要求匹配预览事件发生在绑定之后。接受身份包含完整提交字段、结果及这些版本；即使 HTML 相同，status、conclusionScope 或其他声明变化也递增 bindingRevision、更新结果、清除旧 inspection 与 preview，并重新持久化接受绑定。只有完整身份相同的重提交保持幂等；恢复以最新接受事件的顺序和工具回执的 bindingRevision 排除旧检查与预览。发现变化使旧草稿不可发布，必须重新提交并预览当前版本。新内置提交路径按声明的单个或多个独立决定性差异，限制标题加可见主文为250/600字符、附属解释为400/1000字符；折叠和隐藏解释也计入，已核验的固定原文组件从附属解释中排除。旧自定义端口保留原契约，篇幅和结构校验不证明声明的差异数量或判断正确；常规来源/哈希检查复用Host事实，不因未重复而增造限制。检查方法或精确推导可展开，影响取舍的未知不得藏入详情；证据注册、同公式复算或单帧截图均不证明全局行为。

Comparison 是运行后的可选证据视图，不是新的实验状态机，也不为历史 Runtime 版本提供精确复现保证。报告失败不应改写 CandidateRun 的 outcome；失败诊断保留原任务和草稿排查路径，未经发布校验的草稿正文不能作为正式结论。报告中应明确 baseline、candidate、证据缺口和 cleanup 状态。

## 文件与兼容边界

本节中的严格三会话、阶段保存/推理档位和来源复审描述退休前执行策略及历史材料；当前内置 executor 不再执行它们。TaskCase 发布、模型输入、引用与图片完整性等共享边界仍适用。

严格 Comparison 的保存检查点在完整工具 turn 后切换，允许同批已请求来源工具完成；欠保存重入才阻止来源副作用。阶段截止、整体硬保护及取消仍优先。发现闭合和核稿有已有 snapshot 时优先仅暴露 delta 更新，调查及来源保留完整更新兼容；核稿保留读取、引文、图片、提交、检查与更新工具。完整核稿 turn 实际接受改稿后，可进入仅检查工具的 final-inspection，共享原 audit 绝对截止；仍须当前完整正文进入下一真实 generation 后才预览发布。Pi 按每次实际曝光工具计算上下文开销，窄阶段不预留未曝光 schema。

紧凑 decision 可选 media（最多四个注册短引用及纯文本 caption），由 Host 生成现有图片组件。caption 计入原正文预算，引用、路径、hash、绑定和预览校验不变；无媒体 decision 保持兼容，持久化仍为规范化完整草稿。caption 是待审呈现，不自动增加视觉认证；独立复审需要实际查图并核稿。视觉任务先查结果中的接触、遮挡、裁切及缺陷，再解释会影响取舍的机制；非视觉任务不强制截图。理由见[完整批次与最小核稿工具面](../decisions/accepted/2026-10-10-comparison-batch-and-audit-closure.md)。

严格路径的初存、来源保存、发现闭合、全文交付与预览请求低推理档位上限，调查、作者及最终核稿保持配置档位。控制记录在实际 invocation-start；Pi 不提高 minimal，结束或失败后恢复原配置，压缩与恢复沿用本次档位。旧请求省略上限时保持行为，上游对档位的支持不由配置或请求回执认证。

TaskCase 通过 case.complete 发布，缺少标记的半成品不能作为完整场景。可选历史终稿封存在 `baseline-artifacts/manifest.json` 与配对的 `baseline-artifacts/files/<bundleId>/…`；旧 Case 无清单时由 attempt `derived-history/` 补证，不写回已发布 Case。Experiment 使用自身的日志与文件协议，不能套用 Case 标记。只读 History 不申请 writer 锁、不改写日志；未知 schema 和完整坏行需要诊断，不能跳过坏行拼出完整轨迹。持久化 compare 与历史摘要依赖 record.json；Store 能 replay 不证明记录文件丢失时应用会自动重建。

进入模型的正文先经过秘密过滤，再持久化并发送；超出内联预算的内容使用带 hash/长度的附件，重建时校验。Pi 内存 transcript 不是另一份持久化真相。角色工具读取的正文同样需要可复原的事件／附件记录，仅保存可变文件路径或 digest 不足以重建输入。

Comparison 每次使用独立 attempt。严格三会话路径的调查、短作者、独立 source/review 各自新建 Session；作者仅用原任务及实际保存假设，独立 source 初始输入不携带作者对话。其他新提交端口仍由调查与作者共用 Session、首次审阅另建 Session；后续修正复用其独立 Session。旧直接报告端口仍保持连续 Session。新提交路径按定向调查、提交、审阅三轮推进；首轮先读取确定性 briefing 索引，只追查会改变结论的问题。`comparison.phase_completed` 记录每段耗时、模型请求、工具调用、压缩和预览次数；旧四轮 JSON 信封仅保留给旧端口。可执行 Prompt 以 [`comparison-agent.ts`](https://github.com/caulif/Reprise/blob/8d528d5/src/agents/comparison-agent.ts) 与 [`comparison-review-findings.ts`](https://github.com/caulif/Reprise/blob/8d528d5/src/agents/comparison-review-findings.ts) 为文本源：以任务成功标准选证据形式，点名 `render_artifact` / `register_evidence` / `preview_report`；截图与页面查看只走这两个受控工具，禁止经 `shell_exec` 启动 Chrome/Edge/Firefox 或做 `--version` / `--dump-dom` / 用户 profile 探测；渲染失败则记录 limitation 并继续文本证据，不得用等价浏览器 shell 重试。Prompt 是第二道防线，不能替代 Comparison 工具装配层的 shell 边界。提交时 Host 检查短引用、媒体、结构和安全内容；review 须预览且改稿后重检。取舍见[草稿提交与版本发布](../decisions/accepted/2026-09-26-comparison-draft-publication.md)与[禁止直接浏览器 shell](../decisions/accepted/2026-09-20-comparison-prompt-no-direct-browser-shell.md)。Host 持有确定性指标和模板区域，Agent 写本次任务的差异与判断；未知 token、价格或用量不是零。候选 snapshot 缺失或不完整时明确 unavailable，不能悄悄改读可变运行副本。

生产 `requireFindings` 路径在初始调查实际 `bounded_investigation_timeout` 后，若 findings 未 ready，由 Host 串行关闭已接受 snapshot 中的 pending 问题：仅改为 unavailable 并注明调查截止，保留原身份、decisionImpact、引用、nextCheck、观察和限制。复用原当前 catalog 校验与 artifact/event 持久化；没有保存、引用失效、取消或持久化/审计失败不得 compose，不付费重写占位。`comparison.investigation_closed` 记录前后绑定、问题 IDs 和非语义认证的过程来源；下一真实模型输入明确带入该来源，不伪造模型 tool call。独立 source、实际 reviewer findings 更新、重新正式 inspect 和 preview 链保持必需。取舍见[Host 调查截止闭合](../decisions/accepted/2026-10-06-comparison-host-investigation-closure.md)。

退役前的阶段工具面由 `comparison-stage-policy.ts` 的显式阶段策略统一定义；同一策略决定模型曝光、执行与完成回调守卫及退出条件，资源计量独立保留。旧端口的默认曝光保持兼容，严格路径使用阶段允许列表；参数相关的报告路径、修复读取和当前检查绑定仍在执行时核对。`ComparisonAgentPort.requireFindings` 显式声明 findings 协议，统一选择草稿绑定、findings 工具与回调、持久化独立审阅契约；代理或装饰器无需继承内置类。可选 `reviewInspectionRequired` 保留不启用 findings 的旧内置全文检查协议。引文正文是已注册原文，媒体枚举与路径重写跳过其正文；真实 markup 的网络资源和未注册媒体仍被拒绝。见[统一阶段策略与端口能力](../decisions/accepted/2026-10-06-comparison-stage-policy-and-port-capability.md)。

严格新审阅首轮得到原context导航及当前saved findings绑定、ID和待证假设，独立读取原任务、决定性来源及实际交付链，不携带作者对话或打开作者稿。source实际工具面仅含合法source工具与发现更新，提示优先使用delta；查证后立即保存，不以文字总结代替持久化。独立source marker只记本次精确accepted回执和实际非空saved state，正文检查点不重置它；当前state须仍完全一致，ready须重新检查。只有source正常completed或明确independent_findings_ready/pending边界才可使用该保存事实，旧ready、缺失state、拒绝、伪回执、超时及output_limit不能跳closure。实际accepted-ready在完整工具turn让出independent_findings_ready，取得真实完整草稿后直接full audit；accepted-pending让出independent_findings_pending，取得草稿后仅一次补查再最终closure。没有有效source保存证据则执行原最多两次review-findings，每次重置closure accepted标记；只准update及严格修复read，实际accepted且当前ready才能进入audit，相同合法snapshot可幂等接受。第一次closure接受pending也仅开放一次review-supplement，不写稿、提交、更新findings或预览，之后最后closure必须从真实证据解决问题或保留身份、历史、decisionImpact并明确unavailable；仍不ready就失败，无第三次。source保存不认证事实，不豁免实际稿件checkpoint、full audit、新正式inspect、后续generation和matching preview。旧source端口不注入作者findings、继续禁止source更新，并保持原两次closure。见[有界审阅收敛](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。工具、catalog、draft、阶段状态、审计与资源 tracker 仍属于同一 attempt，模型请求、工具、累计费用和开始时间不因换 Session 重置。创作失败不创建审阅 Session；attempt级取消signal跨会话存在，cancel与进行中的release先取消attempt再关闭当前缓存Session；旧Session关闭空档中取消也不创建付费review，新Session图片交付权限从空集开始，不继承旧Session图片。取消与release指向当前缓存的新Session，返回的 sessionId 来自实际审阅，模型输入仍逐请求审计。换会话本身不增加审阅轮数或并行模型调用，也不放宽预览、digest 与原生图片交付要求。

旧 attempt 可通过 `recover-comparison` 离线复核：只读冻结 context、catalog revision、预览事件与原草稿，重新运行当前校验器。缺失预览、digest/revision 不一致或校验失败不得恢复。显式 `--publish` 仍以兼容根级 `report.html` 为目标；已有文件仅在同一 recovery intent 和相同发布 digest 下允许幂等完成，否则拒绝覆盖。成功后追加 `comparison.recovered`、更新根级 `comparison.json`，不改写原失败事件或 attempt 草稿，也不生成新的 run-owned result/owner 清单。根投影不因此取得新 owner 认证，不能仅凭恢复成功把它归到当前 run。

退休前的阶段执行器曾按调查软额度、审阅预留与整体硬保护决定调查和创作时机；这些旧默认值及 override 语义仅见历史[资源保护决策](../decisions/accepted/2026-10-05-comparison-scoped-findings-and-resource-protection.md)，不再是当前可启用配置。当前预算只以上文[Comparison attempt](#comparison-attempt)和有效配置快照为准。Pi 生成与压缩的真实请求及 usage 审计、费用未知保护与失败/取消不覆盖已发布报告等共享不变量继续保留。

旧端口未启用局部 deadline 时，调查与 source pass 的软预算在 Pi 完整 turn 的安全边界机械执行：usage 汇报后，Host 的 yieldAfterTurn 通过 SDK 现有 shouldStopAfterTurn 阻止下一次生成，返回明确 yielded，记录 agent.invocation_yielded；comparison.phase_completed 附实际 outcome、pass 与 yieldReason。它允许正在执行的 Provider 请求与整批工具完成，不宣称精确抢占；原整体硬预算不变。调查可用剩余额度做至多两次实际 findings closure invocation；严格路径同样受原调查阶段绝对截止约束，不能因 closure 重新获得时间；closure 工具边界先检查共享硬额度，再机械拒绝除可用发现更新以外的工具，软额度未耗尽时也不允许新调查；内部工具反馈可在同次调用继续修正，仅真实 findingsReady 就绪后才 findings_ready yield 并进入 compose，口头承诺不制造保存状态，第二次仍未就绪即失败；source pass 被让出时明确不完整，未知成功保证不得认证。draft 收尾不按累计 review 软额度在每个内部 batch 后退出，允许修复历史发现、重提、正式 inspection、preview 及后续 generation 在同次调用内推进；扩展 read/render/register 调查继续按原软限制拒绝，共享硬额度和无进展边界不变。Provider 必须 idle 才能进入下一阶段；取消、真实错误与硬失败优先。正式发布还须证明当前完整 inspection 已进入后续 generation 实际输入，inspect 与 preview 同批成功不足以立刻 report_ready。生产新路径在每次实际核稿开始时撤销正文检查点的正式认证和旧预览，保留已经真实送入 Session 的正文用于核稿；只有该核稿边界之后新完成的正式 inspection 才能让出并进入收尾，拒绝读取或口头结束不能沿用旧认证。新增 comparison.draft_audit_started 记录此边界，新的 reviewInspectionContractVersion=2 在 live/Recovery 都要求最终 inspection 晚于当前 audit-start；新 reader 兼容版本 1，旧 reader 拒绝版本 2。在实际完整核稿 turn 后，让当前正式 inspection 进入同 Session 的下一次真实 generation，再仅执行 preview_report；该工具 turn 的 report_ready 仅表示机械预览就绪；严格生产路径随后以同一独立 Session 的真实预览结果发起 presentation-review。审阅者检查任务差异、用户影响、关键未知及展示质量；可提交基于已核证据的修订，修订后重新核稿、正式读取与预览。只有后续审阅真实 completed 且当前绑定仍可发布，Agent 才返回成功；失败、取消、截断或截止不能用旧预览覆盖。旧非严格端口保留原收尾。见[通用报告展示审阅](../decisions/accepted/2026-10-11-comparison-presentation-review.md)。预览失败或版本失效回到有界核稿修复，取消、硬限与真实错误仍优先；旧无 getter 端口保持原流程。新 audit 调用开始时若 reviewReason 已耗尽，实际工具集合按原资源策略隐藏执行边界本来拒绝的扩展检查，保留 read 供合法修复及检查、提交；未耗额度仍保留扩展检查，原执行守卫不变。见[仅预览收尾](../decisions/accepted/2026-10-06-comparison-preview-only-closure.md)与[安全阶段让出](../decisions/accepted/2026-10-05-comparison-safe-turn-yield.md)。

严格三会话路径独立 reviewer 使用专用短系统提示，保留实际来源、输出链、反证、支持范围、问题历史、Host指标和版本发布约束；首次source输入隔离作者对话，但包含当前saved findings的绑定及待证假设，保存记录始终不作事实认证，优先绑定 delta 与紧凑 decision，减少重复输入和输出。旧端口保留通用提示，不调整模型参数。严格核稿仅 completed 或明确 final_inspection_ready 才进入预览，output_limit 或阶段截止不能凭旧 inspection 发布。

以下阶段截止仅适用于严格三会话路径、启用阶段边界并显式配置阶段资源的情况；默认仅含 `maxElapsedMs` 的 24 小时策略只检查整体时间，不启用这些阶段截止。1200 秒是显式阶段策略的比例缩放基准，不是当前默认总预算；阶段上限与预留按配置的 `maxElapsedMs / 1_200_000` 缩放。此时初存、调查及 findings 收尾共享调查绝对截止。1200秒基准下调查/调查保存/作者上限240/120/180秒，后续预留780/660/480秒；保存预留包含完整作者窗口，避免保存与作者共享同一截止。来源复审/来源保存/正文交付/最终发现/audit/preview上限300/120/120/120/180/120秒，后续预留360/300/270/210/90/30秒。来源初查另限240秒、唯一补查另限60秒，不越过共享来源截止。所有阶段首次进入后截止不重置；调查保存仅累计实际保存时间，返回来源不续期。显式总额度同比缩放（含大额度），更小 investigationMs 保持有效。正文交付超时立即失败，不认证未完成调用；保存中断后仍须实际取得正文、完成必要的真实最终发现更新再核稿。过期不发新请求，修复也不豁免；取消、真实错误和整体硬限优先。未产出可发布检查点的bounded让出失败保留 agent_timeout/timeout和阶段原因；专用闭合器已处理的超时保留业务code和timeout类别，不自动重放整个attempt；其它让出保持协议失败。阶段快照记录 workStage/workDeadlineAt/workRemainingMs，控制从 invocation-start 的 yieldDeadline 复原。非严格端口保留局部截止兼容策略。见[稳定性与阶段保留](../decisions/accepted/2026-10-10-comparison-stability-reserves.md)。

宿主在已提交来源工具完成回执之后自动追加 comparison.evidence_checkpoint，引用 sourceToolCallId、hash及字节数并标明 not_certified。原始证据不依赖模型语义保存才能保留；进度索引不证明检查成功、不编造结论、不支持任意阶段续跑。机械 inspection/final-inspection/preview 可通过已审计 maxOutputTokens 限制generation输出（默认4096），不影响compaction额度；一次有界output_limit续写和实际工具/发布认证不变。几何 missing/ambiguous 的可选 selectorDiagnostics 只包含匹配数与最多4个元素身份，过schema/字节/绑定校验，帮助修正查询而不证明对象角色。

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

旧严格三会话路径曾按来源、保存、最终发现、核稿及预览使用不重置的阶段截止，并为收尾预留请求与工具额度。该调度及软额度已经退休，不因历史字段仍可读取而重新生效；历史回执按已记录的阶段、余额和绑定复原，缺失证据不补造。findings 结构/来源验证不认证自然语言，当前与历史发布都不能用失效预览兜底。

## 共享工具与历史认证

Comparison的read结果现在只将实际存在的available/truncated/offset/byteLength/returnedBytes/totalBytes/nextCursor白名单投影到模型可见hostProgress.readCoverage；类型不符或缺失不补造false/0，不透出物理路径/任意details。读取覆盖描述本次返回范围，不保证原运行完整记录；模型不能因正文很长猜测截断。该反馈与原工具结果一同审计/压缩/恢复，文本和原生图片工具实际块均可见，旧直接端口不受影响。

Comparison 的 `quote_evidence` 只读取当前 catalog 的已登记文本引用，并从实际 UTF-8 字节生成带 ref、完整来源 SHA-256、字节范围及全文/节选标签的固定 HTML。原文展示复用该组件；派生解释不能冒称原文。提交、预览、发布和离线恢复重读安全 mounts 并核验组件，不因先前工具成功而跳过来源变化检查；有组件却无法验证则拒绝，无组件的旧报告保持兼容。工具尊重 allowModelText，拒绝二进制、非法 UTF-8、越界或切断多字节范围以及超出 16KiB 输出的请求，不静默截断。该能力认证引文字节和范围，不认证自由文字中的事实、判断或完整性；这些仍须语义审阅。

历史独立复审协议要求在最后一次接受修订后重新读取实际正文，绑定稿件 digest/catalog/findings/声明；作者阶段读取不跨 Session 生效。预览不代替正文读取。恢复对启用该契约的 attempt 校验其 review Session 的读取记录，未启用的旧报告保持原认证。历史篇幅按其原格式限制，不套用当前 format 3 预算；读取与篇幅门均不认证语义正确。

旧独立复审在同一新 Session 内先审原任务与决定性原件，再核接受稿；其来源/保存截止和工具曝光属于退休策略。历史 review 认证仍要求对应实际输入和有效版本，保存的 findings 不是事实认证。read/shell 未隔离作者文件，该旧顺序也不是完全盲化；正常完成不认证语义。当前自主实现不创建独立 reviewer。

历史紧凑 decision 的 Host 范围投影按精确相等共享字段，保留依据及双侧范围映射；不同范围和未知不合并，自动文字仍计入原详情篇幅。作者不得仅为满足篇幅改变 findings 的检查范围或 disposition。共享 workspace 工具的纯非法路径前置拒绝仍允许模型纠正合法虚拟路径，并审计实际失败；权限、真实文件系统、审计及持久化错误边界不变。历史理由见[收敛改造](../decisions/accepted/2026-10-06-comparison-bounded-review-convergence.md)。

历史紧凑 decision 的 scopeSummaries 是报告展示层：每项 basis/boundary 对应一个 findingId 及双侧简短范围，非空白并精确覆盖绑定 ID。Host 转义展示且计入原详情预算；完整 supportBoundary 保留于 findings，无此字段的旧稿按原规则投影。摘要语义仍须独审，结构通过不认证它。退休前的正式 audit、按时间 source-save、批次计时及 delta 工具曝光见[历史保存决策](../decisions/accepted/2026-10-10-comparison-timed-source-checkpoints.md)，当前自主实现不执行这些步骤；恢复只认证原日志实际保存的输入与版本，不补造模型请求。

旧来源窗口的 bounded_source_timeout 与最多两次续查属于退休策略，不是当前 Provider timeout 的正常恢复路径。原始生成是否截断仍只能依据原事件明确字段；完整读回执不能证明生成完整，无关导航库存不进入任务取舍。

报告结构检查从实际 DOM 元素属性读取 Host 区数量、顺序、必需槽位、组件模板及布局声明；转义的精确引文正文不能补足缺失结构或制造额外 Host 区。核验措辞诊断、媒体引用投影、派生证据暂存、单侧图片缺失说明及预览会话标签检查复用同一引文保护，原文字节仍在提交、发布和恢复时验证。旧 ComparisonStages 与阶段策略已删除；当前权限和发布不变量从默认工厂及实际 Host 工具入口验证。实验端口可注入 Comparison 预览 renderer，用于固定请求序列的结构测试；默认仍使用真实浏览器，fixture PNG 不认证浏览器能力或视觉质量。

Comparison 的 `view_image({ref})` 只观察当前 catalog 注册的 PNG 媒体，复用原生图片授权、hash、真实路径和交付预算。每图最多 3 MiB、9,216,000 像素，每次附件最多4图及8 MiB；非 PNG 来源须先渲染。当前自主 Session 中工具全程可用；旧阶段权限与保存计数不再执行。旧 `read(format=image)` 保留，默认图片上限独立于文本64 KiB分页，文本最大256 KiB不变；PNG检查限于头部和像素，不代表完整解码。普通图片参数、大小、授权拒绝返回可修正反馈；注册图片完整性、审计与取消仍终止。实际模型输入manifest才认证图片送达，静态截图不认证整个动画或模型判断。理由见[图片工具决策](../decisions/accepted/2026-10-10-comparison-image-tools.md)。

历史 `save_comparison_checkpoint` 契约接收精确 binding、最多一条完整 finding 和可选 finals；保留全部问题、criteria、limitations 与其它 findings，继续由原 delta 校验及持久化队列处理。其 schema、队列与历史认证回归保留，但当前自主工具面不暴露该工具，也不执行 source-save/review-findings 阶段。历史理由见[中途单条保存](../decisions/accepted/2026-10-10-comparison-batch-and-audit-closure.md#中途单条保存)。


## Comparison 并行与历史续查

Comparison 的独立 read/ls/grep/view_image/render_artifact 使用 Pi 原生并行批次；其它工具省略执行模式时保持串行，混合批整体串行。渲染采用独立输出目录、最多两路并发，媒体登记沿用有序队列。当前默认不设置来源或保存阶段配额。累计保存窗口、来源活动时间暂停及最多两次有界续查属于已退休执行器；旧 comparison.sources_continued 事件保留读取，不能据事件 schema 推断仍可启用该模式。

transform_image 裁剪/缩放已有冻结 PNG，使用原图像素坐标并记录父 hash 和变换顺序；返回派生 media ref，再由 view_image 交付图片。工具不重新渲染来源，不证明视觉理解。旧 source-save 的 evidence 投影只是历史输入协议，当前不再执行该阶段；实际输入仍按 generation 快照恢复。首流事件、首文本 delta 与工具执行计时用于诊断，不把首 SDK 事件当网络 TTFT。历史理由见[并行与续查决定](../decisions/accepted/2026-10-11-comparison-parallel-continuation.md)。

候选快照的依赖省略、可取消收尾与旧格式兼容按 [Controller 执行可靠性](../decisions/accepted/2026-10-13-controller-execution-reliability.md) 执行。候选工作树保留实际依赖，封存仅省略有清单、锁和生成标记支持的可重建目录；scope 记录省略路径与恢复命令，用户明确交付路径可保留。省略目录不是删除执行工作树，也不保证重新安装后与原依赖二进制相同。
