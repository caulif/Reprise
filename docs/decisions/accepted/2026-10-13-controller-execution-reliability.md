# 决策：Controller 执行可靠性与明确的任务模式

状态：accepted

## 问题

Controller 把可纠正的目录读取错误和固定 shell 截止升级成整项失败；未启动 Runtime 的清理产生非法生命周期；外部预算被记录为用户取消。轮次间预算检查不能停止正在运行的模型或 Candidate。执行副本与任意 shell 的读取隔离也不是同一个保证。

## 决定

- Controller 工具边界只恢复明确的参数、路径、文本匹配和会话占用前置错误，返回带拒绝状态、原因和可重试提示的模型可见结果，完成审计照常记录。权限拒绝、取消、审计/日志落盘故障、未知异常和不变量错误不进入这条恢复路径。参数是模型输出，用 schema 校验；不扫描所有异常消息猜测是否可恢复，不自动重试。
- Controller 使用已有 managed exec_command/write_stdin/cancel_process，按 invocation 绑定 session 身份，分段返回输出；命令非零作为结果，轮询时间不限制命令寿命。每个 invocation 结束前必须完成或取消命令；未完成不能被接受。输出日志封存为 artifact。共享工作区命令串行，已有独立文件读取并行声明保留，不新增请求或工具次数上限。
- 未尝试启动的 Runner 不调用 stop/close，不制造 runtime.session_stopped/closed。启动尝试后的失败仍要回收可能存在的进程。总时限是可选配置，缺省没有总时限；旧磁盘上已有的有限配置继续有效。总时限在 Controller 循环期间主动停止模型与 Candidate，不只在轮次间检查。用户显式取消、TimeoutError 预算信号和普通监督器信号分别记来源；未知 AbortSignal 不推断为用户。
- stop、close、capture、release 分阶段记录开始、完成和失败，并分别有截止。capture 获得独立取消信号；超时记 unknown 和资源名，保留工作树，不允许迟到的结果更新终态 artifactRefs。普通失败记 incomplete 并保留封存归属，已提交的 scope 引用进入终态。取消复制可留下不完整标记；重试封存仍走现有 staging/publish 机制。不能把 Promise.race 当作底层操作已停止的证明。
- 候选封存默认省略带清单、锁文件和安装器标记的可重建 node_modules，以及带 Cargo 清单、锁和编译器标记的 target，记录原路径、锁路径和恢复命令。缺少标记的同名目录保留。任务完成模式可显式保留交付路径及祖先。执行工作树和旧快照格式保留；锁文件、命令事件、运行时 manifest 和真实验证证据继续存在。快照 complete 指按此策略封存完成，不代表依赖二进制或运行环境完整复刻；指纹仍可能受既有扫描预算限制。
- TaskCase 显式携带执行模式。缺失 execution 的旧场景和现有历史导入继续 historical_simulation，不能静默改变历史评测。task_completion 必须冻结 goal、deliverables、authorization，直接交接原文，不执行历史理解前置回合；历史文件仅按需。历史模拟仍保留信息出现顺序，不向 Candidate 提前泄漏后续要求或历史 Agent 答案。不自动从历史答案推导“冻结目标”。新任务调用方必须显式选择完成模式。
- 投递 receipt 与 settlement 后持久化轻量进展 checkpoint，绑定 session、client message、turn、投递状态和下一步。未知投递仍终止为 uncertain.input_delivery，不自动重发。进展投影读取真实工具事件和后台命令状态，沉默不等于停滞，不用固定频率模型调用探活。Controller 仍复用已有每 run 持续会话。
- ProductRuntime 通过可选 executionIsolation 端口声明 Host 私有数据读取边界，写入 RunManifest；旧 Pack 缺失为 unknown。内置 Pack 声明 unrestricted。工作区副本、命令检查、凭据路径拒绝和 prompt 都不构成 OS 读取沙箱。当前报告明确不保证盲测公平；不宣称已经隔离历史答案。
- Windows 真实 spawn 后在 Node 原进程句柄仍持有时同步捕获精确创建时间身份。回收使用保持打开的已验证进程句柄保护身份校验至 taskkill 的区间；身份不匹配或不可获取不按裸 PID 回收，只使用原 ChildProcess 句柄，并返回树终止未确认。测试注入的 spawner 不查询真实 PID。此机制不是跨重启进程注册表，也不回收未归属进程。

## 备选方案

**继续以固定超时和异常失败处理所有工具错误。** 无法让模型纠正目录与参数误用，也无法区分长任务与失效任务。

**默认启用系统沙箱和自动重连。** 当前没有可验证的 Windows 隔离与原生会话查询契约，不能以提示词或猜测投递结果替代。

## 影响

新增 TaskCase、RunManifest 字段均可选；旧历史场景不迁移为完成模式，旧 scope 无省略清单仍可读取。已有 session、receipt 和工具事件是恢复依据，不删除旧事实。工具面的 shell_exec 从 Controller 替换为 managed 命令；其他角色保留原入口。

本批没有新增跨进程自动重连/查询投递端口。Claude 当前禁用原生会话落盘，其 reconnectSession 标志修正为 false；未知提交必须人工检查而非冒险重发。持久 checkpoint 支持诊断和明确下一步，不能被描述为已经实现重启后继续运行。可靠的自动恢复需要独立设计原生会话持久化、私密历史保留与查询确认契约。

Windows 未安装新系统隔离组件、未改全局配置或生产应用。OS 私有读取隔离继续是明确降级能力，须在具备平台支持后另行实现。真实验证与离线回归各自说明，不能以模拟进程身份复用证明操作系统行为。

## 验证

回归覆盖目录误读后的继续读取、参数拒绝和审计、权限/持久化/取消不恢复、未启动清理、预算/监督器来源、收尾超时和 close 失败、依赖省略和交付路径保留、进程身份不匹配拒绝、完成模式直接交接及历史模式兼容。真实 Windows managed 命令与模型流程的结果在 PR 单独报告，不将任务完成判断视为 GUI 或原文档全页验收。
