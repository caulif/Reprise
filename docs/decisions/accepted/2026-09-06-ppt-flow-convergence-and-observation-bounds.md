# 决策：Controller 内部完成纠错与有界证据分页

状态：accepted

## 问题

PPT 回放暴露了两类独立故障：Host 把 Controller 账本冲突转换为候选续做指令；Comparison 的记录数分页允许单次返回数 MB 内容。简报索引与工具根目录不一致也使按路径读取失败。

## 决定

Controller ledger 的 unresolvedActions 是当前剩余事项的唯一来源。merge 只追加，replace 提交剩余集合，空数组清空；contract 是 ledger 的投影，节点以标题摘要标识，不推断执行顺序或以任意 evidenceRef 自动验收节点。已有节点格式继续可读。

完成门以 ledger 是否存在判断兼容模式，不能依赖派生 contract 的存在；具备 understand 能力的 Controller 必须有可读且 schema 有效的 ledger。每次写入先原子持久化 ledger，再写派生文档、contract 和 manifest。派生写入失败会中止当前操作；从权威 ledger 重试 merge 且不传增量可幂等重建投影，不把缺失或陈旧投影当完成依据。

done/satisfied 在有理解账本的运行中必须通过剩余事项与当前请求证据检查。Host 拒绝只反馈给 Controller，最多两次纠正机会；耗尽则以 stalled.controller_completion_guard 由 Harness 停止，不能通过拒绝上限转为完成。候选输入只来自 Controller send，输入 turnIndex 与实际 Target 投递数绑定。

当前决策读取的候选结果通过每请求回调登记为 controller.observation_read，并保存可追溯的读取 artifact；读取导航索引不算候选结果证据。有效非满意 done 映射为 incomplete，终止性质保留原 reason，不以文字推断改判成功。

shell_exec 返回的模型可见输出、脱敏命令、相对 cwd、退出码、输出字节数和截断标记通过 schema 校验后持久化为 shell artifact，观察来源为 workspace_shell。它可作为 Controller 判断的可重放材料，但不会单独满足 workspace_read 完成门：空输出的成功命令、仅列目录或失败命令均不能代替读取当前候选交付。工具回调只接收同名工具的结果，并绑定当前 request。

Recovery 与 Comparison 共用有限页面算法。普通响应保留数组协议；超大单条返回 schemaVersion=1 的 JSON 片段，包含 index、ref（可用时）、originalBytes、offset、excerpt 和 nextOffset。offset 使用 UTF-16 索引，nextOffset 继续同一条，nextCursor 前进到下一条。最终原生 text block 的序列化大小不超过 48,000 字节；历史与事件原件不截断。隐私投影在分页前执行，审计保留游标、偏移、数量和结果摘要。

Comparison 工具路径相对 attempt 根，简报文件明确以 briefing/ 开头，candidate/ 只指候选副本。Planner 与 Reporter 共用这份索引。

Pi 在请求前使用 transformContext 检查上下文，预算覆盖固定提示词、工具定义和输出预留。无法摘要或摘要后尾部仍超限时返回 Context budget 诊断。瞬时网络或上游失败最多三次响应尝试，通过原 session continue 保留已完成工具结果；Host 不重放整个输入。schema 修复与响应恢复共享一次请求的 deadline，取消信号覆盖退避。恢复尝试通过 agent.request_retried 记录。

Harness 工厂以同一份 AgentBudget 配置实际 Host timeout 和 manifest 预算；默认每次调用为 24 小时，受控运行可分别传入一般调用与 Recovery 预算。生产 TUI composition 接受可选的实验 policy 和内部 AgentBudget，不改变用户选择的候选模型。每次调用预算不代表从探测到比较的整次流程预算，两者分别验收。

RecoveryAgentPort 暴露可选的只读 timeoutMs；生产 Agent 的模型上下文预算、Host 定时器及恢复输入审计均采用此值。未声明预算的旧适配器保留 600,000 毫秒的上下文兼容值，不据此推断该适配器实际执行超时。

Agent Host 将请求取消信号、session 取消信号与单次调用超时合并，取消会释放 Host 等待并中止工具信号，不依赖 provider 主动完成响应。Recovery 的请求信号从 TUI 经 workflow 传至连接探测和模型调用，包括 readiness feedback 和候选重执行。取消后在阶段边界停止后续工作，通过已有失败记录和 staging 清理结束；禁止利用此前 completed 信封继续自动发布恢复候选。文件系统中已开始的操作仍需等待返回，取消不声称已撤销外部副作用。

实验取消信号同时传给 Comparison Planner 与 Reporter。Planner 取消会停止 Reporter 启动；Reporter 取消以 cancelled 比较信封落盘，不发布成功报告，也不改写已经终止的候选 outcome。preflight 返回时检查 TUI 取消请求，取消后不启动 Recovery。关闭 TUI 的等待包含恢复清理完成，返回封面或停止渲染不是清理证据。

关闭等待包括 activeExperiment 的终态结果及其 cleanup 状态、正在恢复的 Promise、待确认恢复副本的丢弃。清理错误不吞掉：关闭 Promise 返回失败，公开错误信息不包含 provider 私有细节。恢复失败时，cleanupFailed 和仍需清理的 staging 引用通过进程内 RecoveryAttempt 返回，磁盘事实仍由 recovery.cleanup_failed 事件承载；TUI 保留失败引用以供检查和重试，取消提示不能覆盖清理失败。

准备与启动 Promise 同样属于关闭等待。关闭发生于 preflight、候选校验或恢复验收期间时，在异步边界返回后禁止启动下一步；若实验句柄迟到，取消该句柄并等待终态及 cleanup。比较确认页的待决选择在关闭时解析为不比较，防止关闭等待残留的交互 Promise。

关闭后迟到的 Recovery 结果仍交给统一 staging 丢弃流程；清理失败保留 RecoveryAttempt 引用，并让 recoveryFinished 拒绝，关闭流程据此报告失败。请求已失效不能作为吞掉资源清理错误的理由。

TUI 对候选启动持有独立取消信号。页面仍在确认页、候选校验尚未把界面切到 running 时，只要 `startupAbort` 已建立，Ctrl+C 取消启动而不是关闭 TUI。返回封面和关闭同样触发该信号。候选校验与恢复验收返回后检查取消，workflow.start 将信号传给 Harness 探测，并在探测返回后再次检查。实验句柄建立前保留恢复副本引用，取消时完成丢弃；句柄建立后由实验负责其运行资源。workflow、Recovery 和 closing Promise 在赋值时即有观察者，关闭等待用 `allSettled`，避免 `unhandledRejection`。

结果与历史分别展示任务判断、运行终止和 Comparison 状态。失败诊断标为 Diagnostic，保留旧成功报告。历史和结果页支持 Esc 回封面；运行阶段依据共享 Runtime 生命周期事件投影。发现摘要复用共享注入指令识别，配置密钥完全遮罩。

通用错误页使用“无法继续”，正文按探测、Recovery、Controller opening 和后续 Controller 阶段展示失败类别与可重试性，不显示原始 provider 错误正文。项目显示名沿用 catalog 元数据并标注来源；目录取所选分组会话 cwd，缺失时取 catalog path。窄屏把选中项目的来源信息放入列表区域，不依据名称推断路径。

## 备选方案

- 提高模型窗口或减少每页记录数：无法约束单条巨型事件。
- 反复让候选继续：不能修复 Controller 私有账本，额外产生付费输入。
- 改 merge 空数组语义：会让既有增量重放产生不同含义。
- 新建事项工作流引擎：当前只需一个剩余集合，无需增加执行调度层。

## 影响

变更涉及工具响应的兼容扩展、提示词及完成护栏；旧事件和节点格式保持可读。纠错反馈进入 controller.requested 快照，读取正文进入本地 artifact。TUI 不维护新的实验状态机。

## 验证

使用合成 5.1 MB 首条事件、含多字节字符及转义的续读、真实工具索引读取、同 session 跨 request 证据绑定和 ledger 清账回归。默认测试不连接模型服务，最终工程验收使用 npm run check。
