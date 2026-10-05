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
