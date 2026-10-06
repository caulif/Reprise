# 决策：Comparison 以一次补查和共享阶段截止收敛审阅

状态：accepted

## 问题

独立审阅可以从真实来源发现新的决定性问题，但原 findings-only closure 不允许查证。实际接受 pending 更新后仍留在同一窄工具调用，随后再次 retain pending，无法进入核稿。另有 findings 和 audit 生成仅受整体截止约束，调查软预算不能阻止这些回合耗尽发布余量。增加恢复次数或总预算不能解决该状态冲突。

## 决定

严格路径由 `getSubmittedResult`、`enforcePhaseBoundaries` 与 `reviewFindings` 同时启用。调查、短作者和独立审阅继续使用各自 Session，资源属于同一 attempt。独立来源初查、实际稿件交付之后执行 findings closure：真实精确 accepted 回执且当前 ready 才能进入核稿；实际 accepted 但仍 pending 则在完整工具 turn 后以 `review_findings_pending` 让出，不继续重抄。

第一次 closure 接受 pending 时，在同一独立 Session 只开放一次 `review-supplement`，处理保存的问题及其下一项必要检查。模型可见名单与执行守卫均仅允许已注册的 read、ls、grep、shell_exec、render_artifact、register_evidence、quote_evidence；原文件、沙箱、shell、来源登记和审计边界继续生效。不开放 findings 更新、报告写入、提交、inspection 或 preview，也不把保存的假设当证据。补查结束必须执行第二次实际 closure；未查清的问题由模型提交 unavailable、精确原因和原 decisionImpact，保留历史身份。Host 不补造观察或事实答案。第二次仍无 accepted-ready 即失败，不追加第三次。首次输出截断仍消耗两次 closure 中的第一次机会，不叠加额外 continuation。

启用严格路径且配置整体 `maxElapsedMs` 时，每个 work pass 使用共享阶段绝对截止。以600秒为基准，调查120秒、作者90秒、来源审阅及其检查点/closure/补查150秒、核稿及最多一次修复90秒、预览收尾90秒，保留60秒整体保护余量。来源初查另限60秒，唯一补查另限30秒，仍取所在审阅截止的较小值。较小整体额度同比缩放，较大额度不扩大阶段上限；配置的更小 investigationMs 同样生效。各阶段不能借用后续保留时间，重复进入同一阶段或输出续写不重置截止。

初存、调查 findings 收尾、inspection、review findings、audit 和 preview 均不豁免阶段截止。调用已过期不发起新模型请求；工具执行也不能以修复读取例外越过实际阶段截止。现有 Provider 局部 timer、idle 与 usage drain、真实错误优先和取消契约继续生效。控制 deadline 经原 invocation 事件记录，阶段资源快照呈现实际阶段、绝对截止与剩余时间；不新增第二份权威状态或模型观察。空资源 override、缺少严格条件的旧调用保持原兼容行为。

严格三会话的独立 reviewer 使用短专用系统提示，原任务与 source pass 初始输入继续隔离作者对话和 saved findings。提示保留实际输出链、反证、方法/采样范围、问题历史与归属、未知、Host指标、完整稿和版本发布要求；优先绑定 delta 和紧凑 decision，仅替换变化对象，避免整份观察、HTML和过程复述。模型、effort 和 maxTokens 不变；缩短提示是可验证的输入改动，不能认证语义或保证加速。旧端口保留通用系统提示。

补查或 findings 更新不能解除稿件绑定。catalog/findings/正文改变时，旧稿或 inspection/preview 不可用于发布；后续必须审核实际最新稿，核稿开始撤销旧正式认证，再完成新的正式 inspection、后续真实 generation 输入和匹配 preview。严格路径仅允许首次核稿和一次有界修复。核稿只有 completed 或明确 final_inspection_ready 才可进入预览；output_limit、bounded_audit_timeout 及其他未完成 yielded 不能凭已经读取的正文冒充完整审阅。findings closure 同样仅以 completed 或明确 ready/pending 完成边界决定后继；超时、截断不认证实际保存后的语义处理已经完成。不可得决定性问题继续要求 conditional/undetermined 和可见 decisionBoundary，已有篇幅、证据、持久化及发布检查不放宽。

## 备选方案

**Host 将审阅 pending 自动视为已解决。** 混淆过程与事实，且可能保留失效结论，不采用。

**closure 开放全部工具或无限返回 source。** 模糊阶段职责并重复调查；只允许一次问题定向补查。

**增大600秒或更换模型。** 不建立当前流程的收敛边界，本次不采用。

## 影响

该改造建立合法补查与有限退出路径，不保证模型每次给出正确观察或及时完成。局部截止返回不完整状态，不是语义通过。Provider 实际停止与审计 drain 可能占用时间，保护余量不是耗时承诺；忽略可选 deadline 的旧 Provider 不能获得局部中止认证。真实语义、篇幅、布局及跨任务稳定性仍需独立验收，工程门禁不能代替产品通过。

## 验证

回归必须证明：accepted pending 后恰好一次补查；第二次仍 pending 不发布；拒绝、伪回执及 output_limit 不冒充 ready；适配器忽略名单仍无报告或完成回调副作用；截止和续写不重置预算；findings变化后必须重新审核当前绑定；取消、持久化和审计失败仍 fatal。先 build 再执行编译测试与完整 check，记录本版实际结果，不沿用旧版成功证据。

本决策局部替代[独立发现闭合](2026-10-06-comparison-independent-findings-closure.md)、[调查绝对截止](2026-10-06-comparison-investigation-absolute-deadline.md)及[来源复审局部截止](2026-10-05-comparison-source-yield-deadline.md)中的严格路径编排与时间策略；它们的真实审计、错误优先、已收到材料和发布约束继续有效。
