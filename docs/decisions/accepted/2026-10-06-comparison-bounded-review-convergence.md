# 决策：Comparison 以一次补查和共享阶段截止收敛审阅

状态：accepted

## 问题

独立审阅可以从真实来源发现新的决定性问题，但原 findings-only closure 不允许查证。实际接受 pending 更新后仍留在同一窄工具调用，随后再次 retain pending，无法进入核稿。另有 findings 和 audit 生成仅受整体截止约束，调查软预算不能阻止这些回合耗尽发布余量。增加恢复次数或总预算不能解决该状态冲突。首版真实校准的交互例在来源窗口取得工具结果后，没有保存独立 findings；随后 closure 单次生成无工具执行即截止。第二版交互例在调查工具上限后才保存，SDK 拒绝缺字段和额外属性的工具参数，拒绝发生在 Host 工具入口前，因此原事件计数中的零工具并不表示没有尝试。公开 generation 快照保留该拒绝；问题是保存节奏与模型工具契约，不能根据私有推理归因。

## 决定

严格路径由 `getSubmittedResult`、`enforcePhaseBoundaries` 与 `reviewFindings` 同时启用。调查、短作者和独立审阅继续使用各自 Session，资源属于同一 attempt。严格独立来源初查同时允许真实 update_comparison_findings：模型按实际任务、双方封存终稿和保存的待证假设查证，取得有用观察后立即保存，不将全部持久化推迟到最后的文字总结。工具面仅包含已注册 source 工具和 findings 更新，拒绝写稿、提交、inspection 和 preview。旧端口仍禁止 source 更新。

严格路径向模型提供单一 delta schema 的 `update_comparison_findings_delta`，避免完整 snapshot 与 delta 的联合 schema。delta 可携带 `addedFindings`、`addedQuestions`；原有每个 finding/question ID 仍必须恰好一次 retain 或 replace，新增 ID 不能冒充替换或绕过历史身份。Host 从当前真实状态合成完整记录，再以原 canonical schema 与来源绑定校验和持久化；只派生结构，不补写观察、问题答案或决定影响。原完整工具保留兼容，两个工具名在初存、调查、保存窗口、来源、补查、创作、审阅及完成回调均按同一阶段策略守卫，别名不能扩大权限。

正常调查与独立来源审查每完成6次来源工具后，在完整 turn 边界进入仅保存窗口。每个窗口只允许 findings 更新，读取、渲染、登记及其他副作用均拒绝；真实 accepted 回执与当前实际非空 saved state 一致才可继续。pending 可作为保存完成进入下一来源批次，不能被解释为 ready 或语义通过；ready 才可结束调查或来源审查。每个阶段最多5个保存窗口，同 Session、工具和请求累计不重置，调查仍共享原120秒，独立来源仍共享初查110秒及所在审阅截止。旧端口不启用此节奏。达到上限、超时或缺实际接受状态不能继续无限保存，原有有限关闭与失败边界仍生效。

下述 `independent_findings_pending` 是来源阶段的最终完成边界；保存窗口内 accepted pending 只解锁下一来源批次，不立即跳到稿件检查点或补查。窗口不能把之前 accepted 状态复用为本次保存回执。

SDK 工具参数校验拒绝在进入应用执行前，使用既有安全工具审计追加 called/failed，并计入真实资源。审计只保存工具身份与拒绝类别，不复制整份无效参数或完整 SDK 回执到新增事件；模型实际收到的回执仍由脱敏 generation 输入保留。该记录不认证工具执行、副作用或语义。审计写入失败保持 fatal，不能被降级为可纠正参数错误。

受限 workspace 文件工具在 `pathIn` 的纯路径校验中拒绝绝对路径、父级遍历等非法输入时，使用 `ToolPreconditionRejected(invalid_path)`。该拒绝发生在文件系统访问、写入 journal 和进程创建前，仍向模型返回错误并记实际 failed；模型可改用合法虚拟 mount 路径，原拒绝不能污染随后成功的 invocation。仅这项确定性前置校验改分类，不扩大可读写范围或 Controller 能力；真实文件系统、symlink、进程、完成回调、审计及持久化异常继续沿用原致命错误边界，取消与硬限同样不降级。回归须用实际 Pi adapter 证明非法 ls 后可正确读取封存来源并完成、直接非法 write/edit 无副作用，以及拒绝审计和后续合法写入的持久化失败仍不完成。

Pi SDK 可能把真实执行或审计异常作为错误工具结果交给模型，再产出正常最终 stop；因此正常完成边界也必须显式检查 invocation 已记录的真实致命错误与外部取消，不能只在局部截止或安全 turn yield 时检查。完成断言不把局部 deadline 转成成功或新 yield，也不因随后纠正工具或最终文字覆盖原致命错误；Provider recovery 前及其实际 drain 后继续执行错误优先检查。回归必须覆盖普通工具执行异常、拒绝审计失败和后续写入持久化失败之后 SDK 的正常 stop，均不得返回 completed；纯路径前置拒绝后合法来源读取的正常 stop 仍可成功。

实际 generation Provider error response/stream 异常与 Host 致命错误按来源分开记录，避免正常完成检查截断原有 context-overflow/暂态恢复。recovery 前只拦 Host 致命错误；局部截止或 yield 仍让已记录 Provider 错误优先。实际恢复后最新 assistant 为正常 stop，或完整 toolUse 回合通过完成策略正常让出且无策略失败和取消，才清该 Provider 错误；工具效果与 usage 审计必须已完成。error、aborted、length 不清，Host 致命记录永不清。Host instrument 包装的 `AgentToolFailure` 按实际 instanceof 识别，包括执行与审计异常；compaction、模型请求和 usage 审计、钩子异常保持原 fatal 来源。Provider direct 旧入口未经 Host instrument 的普通 raw 工具错误保持普通 stop 可完成的兼容语义，但仍在截止/yield 优先；不以 name/message 伪装包装身份。即使 Host 工具错误文字碰巧包含 context_length_exceeded，也不能按消息降级或恢复。

本次 source 的精确 accepted 回执和实际非空 saved state 由独立 marker 记录，marker不随正文检查点重置；当前 state须与接受时完全一致，且重新核对 readiness。仅正常 completed 或明确 independent_findings_ready/pending 完成边界才可使用这份保存记录，旧 ready、缺失状态、伪回执、来源超时和 output_limit 不能解锁。actual accepted ready 在安全完整工具 turn 以 independent_findings_ready 让出；在实际稿件交付之后可直接进入 full audit，省去重复 closure。accepted pending 以 independent_findings_pending 让出，正文交付之后使用唯一补查及最后一次 closure。没有该有效保存证据时继续原最多两次闭合路径：实际精确 accepted 回执且当前 ready 才能进入核稿；实际 accepted 但仍 pending 在完整工具 turn 后以 review_findings_pending 让出，不继续重抄。

本次 source 有效保存 pending，或第一次 closure 接受 pending 时，在同一独立 Session 只开放一次 `review-supplement`，处理保存的问题及其下一项必要检查。模型可见名单与执行守卫均仅允许已注册的 read、ls、grep、shell_exec、render_artifact、register_evidence、quote_evidence；原文件、沙箱、shell、来源登记和审计边界继续生效。不开放 findings 更新、报告写入、提交、inspection 或 preview，也不把保存的假设当证据。补查结束必须执行第二次实际 closure；未查清的问题由模型提交 unavailable、精确原因和原 decisionImpact，保留历史身份。Host 不补造观察或事实答案。第二次仍无 accepted-ready 即失败，不追加第三次。首次输出截断仍消耗两次 closure 中的第一次机会，不叠加额外 continuation。

启用严格路径且配置整体 `maxElapsedMs` 时，每个 work pass 使用共享阶段绝对截止。以600秒为基准，调查120秒、作者90秒、来源审阅及其检查点/closure/补查150秒、核稿及最多一次修复90秒、预览收尾90秒，保留60秒整体保护余量。来源初查与保存合并窗口另限110秒，唯一补查另限30秒，仍取所在审阅截止的较小值。较小整体额度同比缩放，较大额度不扩大阶段上限；配置的更小 investigationMs 同样生效。各阶段不能借用后续保留时间，重复进入同一阶段或输出续写不重置截止。

初存、调查 findings 收尾、inspection、review findings、audit 和 preview 均不豁免阶段截止。严格调查已实际保存且当前 ready 时，在完整工具 turn 提前让出 findings_ready，不为了吃满调查上限继续检索。调用已过期不发起新模型请求；工具执行也不能以修复读取例外越过实际阶段截止。现有 Provider 局部 timer、idle 与 usage drain、真实错误优先和取消契约继续生效。控制 deadline 经原 invocation 事件记录，阶段资源快照呈现实际阶段、绝对截止与剩余时间；不新增第二份权威状态或模型观察。空资源 override、缺少严格条件的旧调用保持原兼容行为。

严格三会话的独立 reviewer 使用短专用系统提示，source pass 初始输入继续隔离作者对话，但提供 saved findings 的当前绑定、ID和完整待证假设，明确不是盲输入、来源证据或作者批准。独立来源工具和实际完整核稿继续承担查证责任。提示保留实际输出链、反证、方法/采样范围、问题历史与归属、未知、Host指标、完整稿和版本发布要求；优先绑定 delta 和紧凑 decision，仅替换变化对象，避免整份观察、HTML和过程复述。模型、effort 和 maxTokens 不变；缩短提示是可验证的输入改动，不能认证语义或保证加速。旧端口保留通用系统提示。

补查或 findings 更新不能解除稿件绑定。catalog/findings/正文或报告结果 status 改变时，即使渲染后的HTML digest不变，也更新接受结果并递增接受绑定，旧 inspection/preview 不可用于发布；后续必须审核实际最新稿，核稿开始撤销旧正式认证，再完成新的正式 inspection、后续真实 generation 输入和匹配 preview。严格路径仅允许首次核稿和一次有界修复。核稿只有 completed 或明确 final_inspection_ready 才可进入预览；output_limit、bounded_audit_timeout 及其他未完成 yielded 不能凭已经读取的正文冒充完整审阅。findings closure 同样仅以 completed 或明确 ready/pending 完成边界决定后继；超时、截断不认证实际保存后的语义处理已经完成。不可得决定性问题继续要求 conditional/undetermined 和可见 decisionBoundary，已有篇幅、证据、持久化及发布检查不放宽。

## 备选方案

**Host 将审阅 pending 自动视为已解决。** 混淆过程与事实，且可能保留失效结论，不采用。

**closure 开放全部工具或无限返回 source。** 模糊阶段职责并重复调查；只允许一次问题定向补查。

**增大600秒或更换模型。** 不建立当前流程的收敛边界，本次不采用。

## 影响

该改造建立合法补查与有限退出路径，不保证模型每次给出正确观察或及时完成。局部截止返回不完整状态，不是语义通过。Provider 实际停止与审计 drain 可能占用时间，保护余量不是耗时承诺；忽略可选 deadline 的旧 Provider 不能获得局部中止认证。真实语义、篇幅、布局及跨任务稳定性仍需独立验收，工程门禁不能代替产品通过。

## 验证

严格预览仅接受 completed 或明确 report_ready 的调用完成边界；即使已产生实际匹配预览回执，超时或重复输出截断仍不能认证发布。反向用例必须覆盖实际预览后返回未完成状态。

回归必须证明：本次 source实际accepted、state一致与当前ready才能省略closure，旧ready/缺失state/伪回执/来源超时/截断不能冒充；来源保存后正文checkpoint仍必需，binding改变使旧稿stale并要求修复；accepted pending 后恰好一次补查；第二次仍 pending 不发布；拒绝、伪回执及 output_limit 不冒充 ready；适配器忽略名单仍无报告或完成回调副作用；截止和续写不重置预算；findings变化后必须重新审核当前绑定；取消、持久化和审计失败仍 fatal。先 build 再执行编译测试与完整 check，记录本版实际结果，不沿用旧版成功证据。

增量与保存节奏的反向用例还须覆盖旧 ID 缺失/重复、新 ID 冲突、失效 binding、每6次来源工具后的仅保存守卫、pending 接受后续查及5窗口上限、假 accepted 或空状态不能解锁、工具别名在全部阶段不越权，以及 SDK 参数拒绝有安全计数且审计失败 fatal。这些机制尚未证明真实模型性能或跨任务稳定性，须以本版实际发布报告另做语义、篇幅、耗时和布局验收。

本决策局部替代[独立发现闭合](2026-10-06-comparison-independent-findings-closure.md)、[调查绝对截止](2026-10-06-comparison-investigation-absolute-deadline.md)及[来源复审局部截止](2026-10-05-comparison-source-yield-deadline.md)中的严格路径编排与时间策略；它们的真实审计、错误优先、已收到材料和发布约束继续有效。

Host 自动渲染的 supportBoundary 范围说明只共享精确相等的字段，并保留每项依据与历史/当前运行的对应关系。不同 relationship、domain、已检查或未检查项不得合并、截断或语义改写；HTML 转义和原篇幅门禁保持。作者反馈明确自动范围也计入详情预算，不能为省字删除检查范围、未知或改 disposition。真实记录即使精确去重仍超预算，也继续拒绝；不能用去重承诺固定范围必然通过。

真实校准证明自动展开整份 supportBoundary 与短报告契约冲突：不同范围文字本身即可超出详情预算。紧凑 decision 现要求 scopeSummaries，以 findingId 映射每项 basis/boundary（含完整支持项），明确历史/当前双侧的简短范围；canonical 同字段可选以兼容旧稿，提供后必须有 decisionSummary，非空摘要须有当前 findings，双侧文本非空白，相关ID必须恰好覆盖一次。Host 按实际依据编号转义显示作者原文，全部仍计入原400/1000详情预算；无新字段的legacy稿继续原完整投影。完整原始范围不按篇幅改写，不自动截断或放宽门禁。摘要是模型声明，ID校验不认证其语义；每次独立正式audit及有界repair将当前完整getFindingsState（含原范围及revision/binding）追加到真实模型输入，message_appended与generation snapshot保留，实际最新稿仍经inspection交付。独审对照来源、完整范围和报告，纠正扩大的覆盖、改变的domain、遗漏的决定性未知与反证；修订使旧inspection/preview失效。
固定Host briefing、索引与导航读取仍计工具/请求和真实审计，但不触发来源观察保存点；真实来源读取与验证工具仍按6次触发，同阶段最多5窗口。恢复只引用同Session已交付材料和实际保存的问题，不重发完整初始briefing；必要的当前保存state仍在保存窗口提供。闭包已经达到审阅绝对截止时立即失败并保留timeout事实，不再追加0请求的第二次闭包或声称完成了两次真实模型调用。

来源窗口因 `bounded_source_timeout` 中断后，仍必须完成一次实际最终 findings closure：不进入首次普通 closure 或重新打开补查。保存的 ready 不能认证被中断的来源回合；最终 closure 须真实接受且当前 ready，随后仍审核实际稿。剩余未知由模型显式 unavailable 并保持历史身份，Host 不推断答案。原始输出完整性只能依据原事件明确记录；读取工具的完整性回执不认证生成时完整，导航库存和条目数量不进入无关任务取舍。
