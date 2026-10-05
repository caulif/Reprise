# 决策：Comparison 关键发现、资源保护与决策摘要

状态：accepted

## 问题

成功保存证据和预览页面不能证明自然语言判断正确。Comparison 容易把自述、数学复算或有限采样写成完整验证，重复调查已解决的问题，并把决定性差异与主要代价埋在长报告中。仅增加简洁提示无法建立可恢复的发现状态或保护资源；单个任务的成功也无法证明重复稳定性。

## 决定

- 默认内置 Comparison 使用 `update_comparison_findings` 保存任务标准、双方终稿位置、带方法和支持范围的观察、反证、重要限制及影响判断的问题。Host 检查 schema、短引用和双侧归属；缺失材料允许明确 unavailable。注册不证明自然语言主张为真，不新增公开分数或结构化赢家。
- 所有扩展名的已封存历史终稿均可作为通用导航证据，不只登记可渲染文件。读取 manifest 后检查真实路径边界、文件长度与 hash；证据短引用保留原 artifact、来源身份和完整来源集合，不用摘要截断覆盖来源。catalog 接受的来源集合与已有历史 artifact 协议一致；导航证据不自动成为媒体或产生渲染能力，是否可渲染仍由现有受控工具决定。
- 发现记录按 attempt 以不可变 artifact 与 `comparison.findings_updated` 保存 revision、digest 和 catalog revision；工具结果进入正常模型输入审计。问题历史不能静默删除，已解决问题重新打开必须说明新依据。未解决问题须有下一项检查；无法恢复或受资源限制的问题保留解释后结束调查。
- 阶段不允许的提交或预览调用不执行底层工具；回执说明当前阶段、下一合法阶段及结束当前 turn 的动作，避免把等待 Host 切换误作工具错误重试。调查已接受的发现回执同样提醒就绪时返回 Host，由 Host 推进创作。
- 默认新提交路径创作前要求发现就绪；草稿接受版本通过 `comparison.draft_accepted` 持久化绑定 discovery revision、catalog revision 与 HTML digest；离线恢复核对最新发现 artifact 与绑定，且成功预览必须发生在该绑定之后。发现变化后旧草稿不能发布，须重新提交并预览当前版本。自定义旧 Comparison 端口继续沿用旧校验，不自动强加新工具协议。
- 调查软预算限制进一步调查工具，仍允许保存带限制的发现，然后进入创作和审阅；整体硬预算拒绝后续请求或工具，失败与取消保留旧成功报告。生产 `createHarnessAgents` 默认调查软预算为 12 次模型请求、30 次工具调用、120 秒，整体硬上限为 40 次模型请求、120 次工具调用、600 秒；金额上限不默认启用。调用方 `AgentBudget.comparisonResources` 完整替换这些默认值，包括传 `{}` 关闭它们，复杂长任务须显式调高；不新增模式 UI。首次限额用于限制异常材料触发的持续调查风险，不把有缺陷输入的 pilot 当成质量基线，后续仍需有效冻结样本校准。资源保护不是任务已充分理解的语义证明。
- Pi 的实际生成与压缩请求、usage 分别审计，并区分 scope。估算按实际模型和保存的价格口径处理；usage 或价格缺失保持未知，启用金额保护时拒绝继续。该保护基于已返回记录和下一次请求/工具检查，不能保证供应商实账或精确限制在途费用；仍需独立时间和请求保护。
- 压缩请求不能仅保存 digest 和后续 summary：`compactionInput: AgentTextBody` 保留实际 systemPrompt/messages/tools，上下文秘密过滤后同一内容用于发送和审计；不保存 Provider 配置或凭据。沿用正文附件溢出及 hash/图片身份校验。History 返回可选 `compactionRequests`，旧缺输入体保留不完整状态，不能凭 summary 反推原始请求；损坏和缺失附件继续明确诊断。
- Host 在结论后、长比较正文前展示时间与估算费用，Token 分项默认折叠。费用注明非供应商账单及工具费排除，时间保留分秒，Token 口径差异不当作效率评分。format 2 的新 Host metrics 标记约束紧凑顺序；旧无标记页面、旧指标指纹和旧舍入展示可读取，不迁移历史文件。新草稿不能通过删除标记绕过 Host 快照。
- 审阅消费主文长度提示、重要限制与实际布局观察；简单单差异100–250中文字、多个决定性差异300–600字为任务自适应指导目标，不作硬发布门禁。关键限制留在主文，方法和长过程进入详情。源码、执行、采样、复算和自述分别支持不同强度的主张。
- 冻结 12 个跨任务合成样本，分别覆盖代码、文本、数据、视觉、交互与证据不足；运行原序、左右交换、匿名身份变体及重复样本。准备输入不调用模型，真实生成仅调用 Comparison，不重做候选任务。匿名是离线扰动，不宣称生产完全盲化；人工按报告 hash 标注事实、过程归属、限制与取舍，再统计漂移和资源分布。不能把成功生成报告或自动汇总当作语义通过。
- 每个新评估 row 的 `evaluation-inputs.json` 经 core schema 校验，绑定 suite 变体及模型输入文件；plan 与新 ledger 保存其 hash。绑定 source、case、baseline manifest/bytes、experiment 元数据、准备时已有 run 文件/artifacts 及 environment 树，不遍历外部模型配置。事件日志绑定准备时 committed prefix 的字节长度与 hash，允许有效追加的比较事件和新审计 artifact，已有输入不可改写。真实 runner 在任何调用前校验全部选中输入，assess 复核有绑定的 row。修改任务却保留旧 contentHash 不能通过文件 hash 检查。旧未绑定评估保持读取，但需独立的 suite/content 离线核验，不能追认其准备时所有输入均不可变；新真实运行须重新 prepare。

评估日志的前缀 hash 不足以冻结候选过程：新增事件即使 checksum 有效，也只能属于 Comparison 生命周期、comparison 角色 agent 审计、比较输入/发现/图片 artifact 与报告创建的白名单。新增 Runtime/Controller 观察被拒绝；合法比较失败、取消及续审事件仍可追加。

评估账本逐条按 usage 事件的实际 model 与仓库价格快照/运营 override 计价，再汇总生成和压缩的已知部分；不按 requested config 统一套价。任一未知或非法价格、或 usage 覆盖不完整时，总估算保持未知，knownEstimatedCostUsd 仅表示已知部分；pricingLookup 不因部分命中掩盖 miss/invalid。

Pinned Pi SDK 的流缺少 finish_reason、stop reason、finish reason 或 terminal event 的明确错误归为 transient_upstream，复用已有移除失败末尾响应后 continue 的有限重试，保留已执行工具结果，不重新提交初始提示或重做工具。认证与普通协议错误不因类似字样扩大重试。SDK 对 error/aborted 消息初始化的全零 usage 不作为免费事实写入 usage_reported；请求审计仍保留，覆盖缺口及金额保护按未知处理。失败消息已有非零 usage 继续保存，成功的零-token记录仍保留；供应商未给出的账单不能推断为零。

### 独立审阅会话与共享预算

生产提交草稿路径的调查与创作共享 Session，首次 review 前关闭该 Session，再用同一 attempt key 新建审阅 Session。审阅从原 context 导航进入，先读原任务、决定性来源和实际报告；保存的发现只传递尚未验证的语义假设及问题历史，不继承创作对话。后续 repair 留在新审阅 Session，旧直接报告端口继续原来的连续 Session。该边界降低审阅重复作者前一轮解读的风险，但不宣称新会话自动保证语义正确。

资源 tracker、审计 sink、工具、业务阶段、catalog 与草稿仍共享同一个 attempt。请求/工具/已知费用/累计时间不重置；审阅 Session 创建后按剩余时间分配调用超时，生成与 usage 逐请求审计。创作失败不得新建审阅；取消/release 操作当前缓存会话，结果 sessionId 指向真实审阅。保留原来的审阅轮数、preview/digest 约束和实际图片交付校验，不引入并行 reviewer 或额外投票调用。自动化覆盖新会话不携带调查/创作消息、repair 复用、模型/工具/费用/时间共享预算的反向用例，以及取消、release、创作失败与 legacy 行为。

### Host 诊断与普通正文的语义边界

真实评估中，“不含视觉检查”被视觉词表误判为已经视觉检查，而且再次验证把已有 `data-host-limitation` 当作 Agent 正文保留、又注入相同诊断。发布器不再以普通视觉措辞词命中判断视觉主张；这类肯定、否定、引述与建议的语义由审阅负责。显式 `data-claim="visual"` 仍严格检查注册媒体、可用状态与 Session 实际收到的媒体 hash，不因移除词表而放宽。

再次验证先抽离可识别的旧 Host 诊断，以诊断身份去重重投影；保留已发生的不可逆修复诊断，剔除废弃视觉词表诊断。新诊断用 `data-host-limitation` 的值标记其身份，旧 boolean 标记与旧译文继续可识别。不修改历史读取文件；规范化后连续验证得到同一 HTML/digest，避免草稿、预览与恢复绑定失效。当前核验词表仍只提示措辞与引用的机械缺口，不升级为语义正确性判断；该次修复不扩大它的规则。

反向用例覆盖中英文否定、引述、建议不被误称已经视觉检查；普通未标记肯定句不冒充已完成语义审阅。另保留显式视觉主张无注册媒体或无实际交付时拒绝，并验证重复旧诊断去重、废弃诊断移除及连续验证 digest 不漂移。

### 从过程索引直接打开观察负载

真实评估暴露了只读事件类型索引、未打开 `runtime.tool_finished` 负载而遗漏连接失败与验证自述冲突的问题。过程索引及 briefing 副本新增 `observation_path`，共用已有 observation materializer 的 canonical 路径规则；该字段只是指向已物化事件文件，不新增 Runtime 能力或新证据结论。

决策导航只附最近最多 6 条工具完成与可见输出事件路径，说明遗漏数量及完整索引入口，包含结算后事件。按 event type 选择导航，不把负载结论塞进 Prompt，不默认遍历全日志。Agent 判断验证自述时应读对应负载，检查 `truncated` / `originalChars` 后限定范围；缺少完整结果时保留限制。自动化检查索引路径真实可读、保存原始 payload、两个索引副本相同、结算后事件不丢失，以及 bounded 导航和截断范围提示。

草稿接受事件的 operation identity 标识一次接受发生，而非内容 hash：同一 findings/catalog 下 A→B→A 必须记录第三次接受，让恢复能绑定最新的 A 与其后的预览。连续提交同一 A 仍由草稿状态判断为未变化，不追加事件、不使既有预览失效。复用现有事件 sequence 排序和草稿 binding 字段，无需新增持久化 revision；自动化以真实 Store 持久化检查三次不同接受、连续重复幂等和最终 A 的离线恢复。

## 备选方案

**只改 Prompt 或引入固定评分。** 前者不能绑定发现与发布版本，后者会把未知与条件推荐压成排名。默认像素脚本、强制截图或多模型投票会扩大成本且偏离任务，因此复用现有 catalog、受控 renderer、Session 和审阅，新增最小发现协议与可配置保护。

## 影响

新持久化字段和工具输入通过 core schema 检查；旧实验、旧 report model 与旧自定义端口保持读取，不修改 CandidateRun 状态或 Runtime/Pack 能力。默认生产工厂启用资源保护；直接构造和自定义旧端口仍以各自配置为准。真实调用继续显式 opt-in，凭据和本机评估输出不进入仓库。新增门禁附引用归属、版本失效、布局降级、未知成本和取消的反向测试。

## 验证

离线测试检查双侧来源、问题恢复、幂等更新、发现变化使草稿失效、软预算工具出口、硬预算拒绝、费用未知、生成与压缩审计、旧布局兼容及新布局逆序拒绝。受控 renderer 检查新生成报告的桌面、移动端、长正文与展开状态，布局检查不代替语义质量。执行项目 `npm run check`；真实重复评估单独 opt-in，记录模型、输入能力、suite/report hash、usage、费用和停止原因，人工审阅前保留未验收状态。

事实归宿：[证据与 Comparison](../../architecture/evidence-and-comparison.md)、[使用指南](../../usage.md)、[开发与验证](../../development.md)。沿用[草稿发布](2026-09-26-comparison-draft-publication.md)、[原生图片与续审](2026-09-30-comparison-native-image-pipeline.md)及[Host 重建](2026-09-23-host-rebuilt-comparison-report.md)的安全与失败保留边界；资源保护补充而非替代调查的语义停止条件。

独立审阅的取消signal属于整个attempt，不能依赖当前Session缓存是否存在；cancel和进行中的release在旧Session关闭空档中仍阻止新review，初始化失败也清理活动标记。同一attempt不得并发混用Session/资源状态。新的agent.session_started清理实时图片delivery及manifest状态，新Session须重新收到generation实际图片；compaction不授予视觉权限。沿用单Session旧custom port无manifest的tool/message fallback，同Session已交付图片可累计。

真实校准暴露共享 shell 保护把未装配挂载解析为空字符串、从而拒绝任何 scratch 写入的问题。禁止名单仍保护虚拟前缀，物理路径仅对实际存在的挂载匹配；不能以缺失路径匹配所有命令。工具说明直接告知当前平台的 Shell 语法与环境变量写法，并区分文件工具虚拟路径和 Shell 的物理路径。回归用例实际写入 scratch，反向验证现有挂载的虚拟/绝对路径及未装配的禁止前缀仍被拒绝。

后续真实校准暴露整页 CSS 读取、无关元数据穷举与接受后反复按建议字数改稿的问题。新增只读 `inspect_comparison_draft`，从现有报告和接受绑定返回实际 Agent 内容，不新增权威持久化文件；改稿、篡改或版本失效不得返回旧内容。工具结果仍经事件审计复原。接受反馈不把保存的每条限制强制塞入主文，须核其是否改变判断；审阅批量修正后预览当前 digest 并结束，仅新决定性证据或验证失败允许继续修订。该阶段篇幅仅作建议，不跳过原预览、来源和语义核对。包含只读来源路径的分析脚本通过 `write scratch/<name>` 创建，再用 shell 执行，保留既有保守的混合命令保护。

该修复后三份均能发布，但主文 568/740/926 字符，证明建议不足以实现简短目标。新模型工具必须声明一个或多个独立决定性差异，Host 分别机械限制标题与主文合计 250/600 字符；超限拒稿不改变旧接受或预览。旧类型化直接端口可无声明，读取不强升旧协议版本。一个差异的证据、后果与重复描述不得作为多个差异，模型声明的真实性不由字数门禁证明，语义验收须另查分类、事实与决定性遗漏。反向用例覆盖两档超限拒稿、边界接受、旧端口兼容及拒稿保留绑定；详情可展开，但不得藏决定性反证。

独立 Session 不继承作者对话，但也不能丢失已经发生的 Host 检查。`motion_not_proven` 可能是已成功生成同 PNG，不能写成未渲染；未交付图片也不等于未调用工具。受控 renderer 在原工具返回中记录类型化 `renderedCheck`，包含请求和实际采样时间及帧 hash，成功、失败或登记失败均按实际结果记录，不添加模型解释。现有工具结果事件保存该新增输入，生产 attempt 内最近 24 条与遗漏数供草稿读取；不增加第二份权威文件，未恢复的缓存明确覆盖边界，不伪造历史。跨 Session 共享检查事实，不共享图片授权；当前 Session 实际原生交付逐帧独立标注，读取摘要不授予视觉权限。反向测试覆盖同 PNG 仍有实际帧、失败与空帧、提前取消、来源路径不暴露、换 Session 清理图片交付而保留检查事实。

### 复审收敛与收尾资源

复审的扩展调查独立累计，但复用配置中的调查请求/工具/时间软限（默认12/30/120s）；repair或换回其他阶段不重置。整个attempt仍共享40请求/120工具/600s硬限。剩余不超过6请求、20工具或90秒时进入`reserve_finish`，停止read、shell、render、register等扩展调查，继续允许inspect、findings闭合、submit、preview及write/edit；硬限不豁免。资源有限不等于结论可信，未解决的决定性主张必须撤销保证并明确不可判断，不能自动发布旧草稿或跨digest复用预览。

提交草稿端口下，每个工具结果附Host的当前phase、剩余额度及草稿/catalog/findings/preview绑定。反馈进入相同工具结果审计及模型输入，不建立第二事实源；既有JSON结果保持JSON对象、媒体交付元数据不变，旧直接端口不加此反馈。计数及绑定只证明执行条件，不认证语义正确。空资源override维持无额度限制。精确供应商`unexpected EOF`按暂态transport处理，沿既有保留tool-result的continuation，不重播已执行工具；工具解析、认证和带应用前缀的EOF不扩大归类，缺失usage保持未知。

实际评估发现read的完整性元数据仅在details审计而未交付模型。选择在Comparison专用工具外层投影白名单readCoverage（available/truncated/offset与现有字节/游标），不改共享read端口或注入任意details。不存在的字段不推断；本次读取未截断不等于原运行记录完整。反馈沿原tool_completed/body和实际模型文本块存储；模型应省略不影响判断的排除来源叙述，而不是猜测来源缺陷。逆例以实际Pi适配器证明coverage进入文本/原生图片请求，并排除私有路径和非法字段。

Agent正文与可选details只补充决定性差异、必要的可复算论证/反例/方法边界；Host已经提供可展开来源路径、身份、指标与审计，不要求模型再翻译manifest/lifecycle字段或叙述未使用来源。简单任务可不写details，仍须保留改变任务判断的限制；折叠不是免除语义正确性的方式。

### 可验证的原文引文

真实评估中模型把带省略号的节选称为全文，因此提供 `quote_evidence`，只接受当前 catalog 已登记的 `ev-xx`，可选 UTF-8 字节左闭右开范围。Host 从安全只读 mounts 重读真实字节、重算完整来源 SHA-256，自动决定全文或节选标签，返回固定且转义的 HTML。模型路径、模型自报范围标签及工具调用记录都不是引文真实性的权威；正确手写组件也以来源字节核验。

引文组件保留来源 ref、完整来源 hash 与字节范围；提交、预览、完成发布及离线恢复均用同一验证器重读对应来源。组件结构、标签、正文、范围或 hash 不匹配必须拒绝，不能降级成旧自由文本报告；无组件的旧报告继续读取。权限 `allowModelText=false` 不得通过新工具绕过。非法 UTF-8、二进制、多字节截断、未知 ref、来源变化、路径或符号链接越界均拒绝；16KiB 工具输出上限拒绝超大引文，不自动截断并冒称全文。HTML 换行仅按浏览器解析的 CRLF/CR 到 LF 规则匹配，不能 trim 或任意归一化内容。

HTML 元数据和既有工具审计足以复原，不新增 quote registry、on-disk 权威或 Runtime 能力。引文端口使用 ComparisonContext 的正文能力，生产沿用[正文恒允许决策](2026-09-16-allow-model-text-fossil.md)，不重新激活 TaskCase 的化石开关；自定义受限端口仍可拒绝读取。`quote_evidence` 属于有界修稿工具，可在复审收尾软额度内调用，但不豁免 attempt 硬限、不登记新发现。组件只证明来源与范围，不能证明报告判断或自由段落正确；语义验收仍须检查普通文字是否把节选、解释或观察范围误述为全文。反向用例涵盖同长度篡改、标签/范围伪造、HTML 实体、结束标签转义、CRLF、UTF-8 边界、超限、source hash 变化、错误 attempt ref 与恢复来源验证。

### 最终正文复查绑定与解释预算

真实引文校准中，作者已有标题与段落矛盾，独立 reviewer 看到了决定性原件并发现标题问题，却只预览改稿后的布局，未重新读取接受的正文；它还新增了否定已知采样时间的限制。输入重建证明原记录并未在压缩中丢失，因此不追加调查额度，不以更多 Prompt 或截图替代最终文本读取。

新生产独立 review 开始时启用并审计最终 inspection 契约，清空作者阶段的读取绑定。读取当前接受稿的实际 headline、comparison 和全部 details 后才可完成；接受稿 digest、catalog、findings 或 decisionShape 变化使旧读取失效，连续相同稿保持幂等。预览仍是布局条件，不能代替正文读取；离线恢复须对启用新契约的 attempt 核对同一 review Session 中当前稿的成功读取，旧未启用记录保持兼容。工具审计证明模型收到哪个正文版本，不证明它正确理解或完成语义检查。

声明单差异的新稿附属解释正文最多400字符、多差异最多1000字符，主文仍为250/600。统计包括隐藏和折叠解释，排除已经核验实际来源的固定原文引文组件；不能把任意 figure 标记当作豁免。超限不覆盖旧接受稿或预览，旧无声明端口保持兼容。预算只约束篇幅，不证明分类、事实或重要差异完整性；原文引文也不认证旁边的普通解释。逆例覆盖作者读取不跨 review、改稿失效、同稿幂等、同 digest 不同声明、隐藏/嵌套附录超限、真实引文豁免和恢复不可绕过。

契约在新请求事件上声明版本，使“复审未启动”与旧记录可区分；独立 review_started 记录实际 Session。submit 与 inspect 的标准工具审计附当前 bindingRevision（仅有效接受变化时递增），覆盖无findings端口和同HTML不同声明，连续相同稿不强制重读。inspection只在成功工具审计后的onCompleted登记，取消或审计失败不能当作已交付；离线恢复另核标准工具正文与artifact完整性，不能仅凭小型receipt代替实际全文。该revision是现有接受对象的过程绑定，不建立第二份权威稿件。

新契约的离线恢复还须从标准输入重建核对后续 generation 请求携带完整 inspection 工具正文；请求前取消或压缩只保留总结不能满足。请求审计保存待发送输入，不能据此宣称供应商远端实际阅读或语义检查通过。

生产完成查询与离线恢复共用这个实际输入校验。工具回合已结束、receipt 和 preview 已齐备，但尚没有后续 generation 携带完整正文时，查询仍返回未就绪；不能以安全让出控制权绕过全文条件。普通返回与 `report_ready` 出口使用同一查询，不把取消或真实失败转换成完成。旧未声明独立核稿契约的路径保留兼容。

### 先核原件，再核作者解释

当前原例在最终正文绑定门禁正常通过后仍产生错误保证。独立 reviewer 收到了完整源码，却继承注入的作者 findings，把算法目标点与实际最终输出等同；所写验证脚本也只检查目标公式，执行被 review 软时限拒绝后仍保留保证。增加正文读取次数或本例专用词表不能解决验证对象错误。

新生成的 fresh review 使用同一 Session 的两个调用：先从原任务和双侧决定性原件形成自己的审查基线，追踪实际输出链并优先尝试决定性反例；正常返回后再读取作者接受稿，核对并批量修订。两次调用不注入作者 findings，沿原事件审计保留真实输入和输出，仍共享整个 attempt 的预算和累计 review 软限。第一调用失败或取消不进入核稿，不能借新增调用重置额度。

实际复审还表明，检查最强优势不能替另一条独立成功保证背书。来源审查须为准备进入标题或主文的每条保证明确最终可观察关系、覆盖实例与不同下游分支；源码推导也须走到最终变换、写入或返回结果。工具证据被裁剪、分支未核验或仅观测运动时，应删除或缩窄正文保证，不能只在详情补限制。这是任务自适应的审查范围规则，不提供个案 selector 或预设赢家，也不要求穷查所有实例；明确局部范围和未知是有效结果。

来源审查期间稿件 inspection、findings 更新、submit 和 preview 工具拒绝误用；这只是顺序保护，read 和 shell 仍可访问既有文件，不声称完全盲审。算法名称、内部目标、注释和自检都是待核线索；必须核它们是否对应最终可用输出。验证不可执行时收缩其精确或全状态保证，不把正常阶段返回认证为语义正确。之后仍要求实际终稿 inspection 和当前 digest preview；旧直接报告 workflow 保持原行为。反向用例覆盖第一调用失败、取消、稿件工具越阶段、作者假说未注入、同 Session 与额度连续性。

### 版本失效后的可修复核稿

有界几何能力的真实原例中，来源审查新增媒体使 catalog 变化，旧 findings/draft 失绑定。核稿只能收到 inspection unavailable；完整替换 findings 又必须保存全部历史问题，拒绝却只返回裸 `question_history_missing`。四次猜测历史后超时，证明保留门禁但不给修复材料会阻碍收尾。预算不增加，也不静默删除或自动解决问题。

`inspect_comparison_draft` 对文件仍符合接受 digest、仅 catalog/findings 绑定过期的稿件返回 `stale`：实际作者正文、当前检查事实和历史问题身份均可读取，但没有有效 inspection receipt，不登记全文检查完成，不满足预览、发布或离线恢复。文件缺失或篡改仍 unavailable。历史材料标为未认证假设，只用于修复；不注入作者 observations，独立 source pass 仍拒绝该工具与 findings 更新。

更新 findings 仍是完整快照，必须保留每个旧问题的 ID、question 与 decisionImpact；缺失时返回 required/missing IDs 和完整既有问题对象，身份或状态字段错时返回对应问题与明确要求。拒绝不持久化、不修改现有状态；旧已解决问题返回 pending 仍须新 grounds。核稿按独立观察修订、重提当前 findings 与稿件，最终再正式 inspection 和 preview。反向用例证明 stale 可读却不可认证、历史遗漏仍拒绝且可按反馈修复、source 阶段不能提前取得修复历史。

### 工具正文在通用压缩阈值内保真

Pi 的通用 prune 会将超过 16 KiB 的工具正文替换为前缀 stub；实际几何输出与终稿 inspection 曾分别超过 20 KiB 和 52 KiB，导致决定性数值和终稿正文在 generation 前丢失。保留通用预算保护，不按本例提高阈值，也不在 infrastructure 解读应用私有 JSON。

应用工具按 JSON 文本块的序列化字节计预算，为 Host progress 与图片引用预留空间。`render_artifact` 小结果保持完整；大结果先将完整测量、原始诊断和来源身份经 core schema 校验落盘并注册 derived evidence，再返回不超过 10 KiB 的紧凑屏幕点、selector/status/domain/window。局部点、矩阵和 bounds 仍在完整 JSON；若紧凑版本仍超限，明确计数省略的 frame，使用现有 `read` 的 byte offset、maxBytes 与 nextCursor 读取原文件。注册失败明确报告，未读取的省略状态不能支持保证；不存在把未知测量变成成功的默认值。

`inspect_comparison_draft` 的检查历史只提供来源、状态、frame hash、时间窗和图片交付库存，不重复完整几何。正文与 receipt 优先保留在 12 KiB 内；超量库存逐记录显式计入 omitted，超量历史问题独立保存为经 schema 校验的可分页 JSON。纯完整终稿仍超限时返回 unavailable，要求减少过量 markup/引用，绝不发送可认证的部分正文或 details receipt。原测量保留在证据文件与事件审计中；这些投影不授予视觉权限，不证明整段动画，也不增加模型请求或时间预算。

现有 `read` 独立解码每个 byte range，分页切断 UTF-8 中文或 emoji 时会产生替换字符。上述两类可分页 JSON 以 ASCII Unicode escapes 保存：逐 UTF-16 code unit 编码，包含 surrogate pairs；拼接页面再 JSON.parse 与原值等价。contentHash 与 byteLength 按实际 ASCII 字节计算，不改变共享 read 的范围或解码契约。真实 read 的 4096 字节多页逆例验证中文/emoji 的完整测量与历史问题均可无损重建。

历史问题分页是核稿收尾资料，不能因为 review 软调查额度耗尽而不可读。Draft 在本进程记录实际生成的 question-history 精确相对路径与内容 hash，`isRepairRead` 只认可这些文件：maxBytes 显式 1–4096、offset 为文件范围内的安全非负整数、format 为 text 或省略，拒绝其他参数、目录、symlink、越出 realpath(attemptRoot) 的父 junction、损坏或缺失文件。实际字节 hash 和既有历史 schema 仍须通过，生成清单只控制预算例外，不成为证据或语义认证。非 ENOENT I/O 错误继续显式传播。应用回调仅用于草稿收尾；source pass 不获此例外，硬资源上限和现有 read 权限继续生效，不增加工具或额度。
