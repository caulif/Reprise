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
- 审阅消费主文长度提示、重要限制与实际布局观察；300–600 中文字为普通任务的指导目标，不作硬发布门禁。关键限制留在主文，方法和长过程进入详情。源码、执行、采样、复算和自述分别支持不同强度的主张。
- 冻结 12 个跨任务合成样本，分别覆盖代码、文本、数据、视觉、交互与证据不足；运行原序、左右交换、匿名身份变体及重复样本。准备输入不调用模型，真实生成仅调用 Comparison，不重做候选任务。匿名是离线扰动，不宣称生产完全盲化；人工按报告 hash 标注事实、过程归属、限制与取舍，再统计漂移和资源分布。不能把成功生成报告或自动汇总当作语义通过。
- 每个新评估 row 的 `evaluation-inputs.json` 经 core schema 校验，绑定 suite 变体及模型输入文件；plan 与新 ledger 保存其 hash。绑定 source、case、baseline manifest/bytes、experiment 元数据、准备时已有 run 文件/artifacts 及 environment 树，不遍历外部模型配置。事件日志绑定准备时 committed prefix 的字节长度与 hash，允许有效追加的比较事件和新审计 artifact，已有输入不可改写。真实 runner 在任何调用前校验全部选中输入，assess 复核有绑定的 row。修改任务却保留旧 contentHash 不能通过文件 hash 检查。旧未绑定评估保持读取，但需独立的 suite/content 离线核验，不能追认其准备时所有输入均不可变；新真实运行须重新 prepare。

评估日志的前缀 hash 不足以冻结候选过程：新增事件即使 checksum 有效，也只能属于 Comparison 生命周期、comparison 角色 agent 审计、比较输入/发现/图片 artifact 与报告创建的白名单。新增 Runtime/Controller 观察被拒绝；合法比较失败、取消及续审事件仍可追加。

评估账本逐条按 usage 事件的实际 model 与仓库价格快照/运营 override 计价，再汇总生成和压缩的已知部分；不按 requested config 统一套价。任一未知或非法价格、或 usage 覆盖不完整时，总估算保持未知，knownEstimatedCostUsd 仅表示已知部分；pricingLookup 不因部分命中掩盖 miss/invalid。

Pinned Pi SDK 的流缺少 finish_reason、stop reason、finish reason 或 terminal event 的明确错误归为 transient_upstream，复用已有移除失败末尾响应后 continue 的有限重试，保留已执行工具结果，不重新提交初始提示或重做工具。认证与普通协议错误不因类似字样扩大重试。SDK 对 error/aborted 消息初始化的全零 usage 不作为免费事实写入 usage_reported；请求审计仍保留，覆盖缺口及金额保护按未知处理。失败消息已有非零 usage 继续保存，成功的零-token记录仍保留；供应商未给出的账单不能推断为零。

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
