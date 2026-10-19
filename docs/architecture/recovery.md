# Recovery 与隔离

Recovery 的目标是恢复任务前的源码与必要输入，不宣称恢复了所有过去状态。它在候选运行前完成，使用一个可写工作副本、只读 source 挂载、只读 observations 和产品 playbook。默认不安装依赖、不完整构建；候选按实际验证需求准备环境。用户明确要求恢复运行环境时仍按该目标调查与检查，未执行的环境检查不宣称通过。

## 明确 Git 起点

调用方可在 `RecoveryAttemptInput` 或 workflow 的 `RecoveryRequest` 显式传入 `gitStart`：完整 commit SHA 与必填 `inputs` 文件清单，每个输入有相对路径及 SHA-256；空清单明确表示只需提交内容。该契约经过 schema 校验，不从历史 `taskContext.historicalCommit` 自动生成，也没有新增 TUI 自动推断入口。

Provider 在已有隔离 staging 上建立新独立 Git 树，仅获取指定 commit 及其祖先，再复制清单中的哈希匹配文件。后续任务提交、未列出的未跟踪文件和依赖产物不进入新树，不对用户源目录 reset/clean。新树经过预算、源保护和起点校验后才接受。请求和恢复结果分别记录 `recovery.git_start_requested`、`recovery.git_start_restored`；成功路径无需模型，生命周期从 staged 直接进入 validated，不伪造模型调用事件。

此路径要求已有可物化的隔离仓库；超预算导致 sparse、缺少对象、输入不匹配、symlink/submodule 或 LFS filter 均不能声称恢复成功。调用方未明确起点时仍走历史调查；确定性路径拒绝后不会擅自改成另一个起点。第一版仍复用现有 source staging 复制，不是大型仓库复制加速或完整依赖缓存实现。见[轻量化决策](../decisions/accepted/2026-10-12-lightweight-recovery-and-managed-processes.md)。

显式 Git 起点的新默认 Provider 位于数据目录的 `r/<experiment hash>/<recovery-run hash>`，避免实验 UUID、运行 UUID 和 Git sink 目录叠加触发 Windows Git 的路径长度上限。scene 通过可选 `recoveryProviderLayout: compact-v1` 与原 run ID 重建目录；旧 scene 和既有调查路径保持原位置。候选路径解析只接受当前 experiment 的哈希目录与指定 Candidate run，不接受其他实验的副本。这减少内部目录开销，不能保证任意长的数据根或源码路径都被 Git 支持。

## 来源、staging 与 checkpoint

`LocalWorkspaceProvider` 先读取并 fingerprint source，不修改 source。复制受文件数量、总字节、单文件和排除规则约束；超预算时保存 summary 和 excluded entries，staging 的 seed 可以是 `copied`、`sparse` 或 `checkpoint`。完整复制成功后可捕获 provider-owned checkpoint；checkpoint 元数据和 fingerprint 经过 schema 校验。

当前实现会优先复用 source/checkpoint，并按预算建立 staging；“默认空 staging”仍是开放目标，不能写成现状。source 在准备前后有 tripwire，变化会使恢复验证失败。外部服务、远程副作用和未观察到的环境状态不会因本地副本而被宣称已还原。

## Recovery Agent 单任务会话

Recovery 请求先取得该实验 writer、保存自身生命周期的 `initialize` attempt，再发布 activity/control 并初始化 Agent；初始化失败保存 Recovery 的失败诊断与终态，再向调用方返回原错误，保留 HarnessProbeError 重试指导与 AbortError 取消语义，不生成 Candidate RunAttempt。准备、Agent release、Store.close 与准确 activity 的收尾分别执行，后一步不因前一步失败而被跳过；control 先于 writer 释放，关键收尾错误向调用方传播，不改写已形成的 baseline 判断。生命周期字段以 [Recovery schema](../../src/core/schemas/recovery.ts) 为准。

一个 Recovery attempt 使用同一 Session 与隔离工作副本，首次只交付一个恢复目标。Agent 自行调查、恢复与核对，返回短 ready/blocked decision；不固定 understand/restore/conclude 三轮，也不在项目内写 notes 或 recovery.md。上下文压缩由实际压力触发，摘要保留起点、证据位置、已完成动作和未解决项。旧 freeform request ID 仅保留历史读取兼容。

Host 将报告、process logs、临时 home 和冻结 Git 依据放在项目之外，报告仍发布为 recovery-md artifact。新 baseline marker 带 artifactLayout: external-v1；Candidate 副本保留用户原有 recovery.md 和 .reprise/recovery-work 文件。旧 marker 沿用旧清理和报告读取契约，不静默迁移。

普通历史调查中 historicalCommit 是线索，不强制成为 HEAD。Agent 应恢复选定第一条任务输入到来前状态，不能自动采用后来同步基线。Host 在工具可写前冻结受保护 source 的 commit→tree 映射、明确 commit receipt 和源指纹；session_meta/turn_context 的 commit 元数据不算任务成果。选择的 HEAD 必须存在于冻结源，树匹配，不能包含已识别任务成果提交。此机械检查并不证明所有未知历史状态；确切起点仍需历史证据，独立实验审计不能只看 accepted 标志。

Git dirty 检查按 NUL 分隔路径及内容进行，不以 mtime 为判据。与原 source 完全相同的 dirty 文件暂按保留输入处理，这不能独立证明其历史归属；必要输入/答案边界仍由 Agent 调查并披露。通过检查后，Host 仅在隔离副本中封存所选 HEAD 的祖先，清理其他 refs、reflogs、未来不可达对象，再验证 Git 完整性。显式 gitStart 契约保持独立和严格。

机械反馈仅回传具体失败事实；相同失败与文件指纹没有变化时停止。默认总预算 24 小时，覆盖准备、模型、校验与封存，无模型请求数或工具调用次数额度。实验工作流按本次 `recoveryBudget.callTimeoutMs` 保存有效操作总限，配置绑定成功后、真实连接 probe 前，扣除自初始化开始已用的单调时间重设剩余分段截止。显式 `RecoveryAttemptInput.timeoutMs` 与绑定总限不一致时在 probe 前拒绝冲突；没有配置绑定的自定义 Port 沿用显式或默认总限，不从其单次 timeout 猜测整体预算。所有出口先取消计时器再聚合收尾，writer/初始化 attempt 仍先于 activity 和 Agent 构造。瞬时故障使用既有进展感知重试，截止后不得接受 ready。决定见[组合边界](../decisions/accepted/2026-10-15-remediation-integration-boundaries.md)。

ready 表示必要任务输入已具备且 Candidate 可开始，不默认要求依赖安装或全量构建。blocked 表示继续需猜关键输入、任务条件或答案边界；未验证内容应披露，不能通过改时间或查 Host 源码绕过检查。

## 受管命令与并行

Recovery 默认使用 `exec_command`、`write_stdin` 和 `cancel_process`。命令首次等待默认 10 秒，返回 running 与 invocation-owned 会话句柄后可继续获取新增输出；等待时间不是命令生命期，不再受旧 shell 默认 60 秒限制。旧 `shell_exec` 仍供未启用 managed execution 的调用方兼容使用。命令非零退出保留实际 exitCode，失效/越权句柄、工作区忙及编辑不存在的文件属于可纠正前置条件；审计、未知 I/O 和受控写入故障保持致命，并立即取消模型调用。

文件读取、列表与搜索声明并行；独立 observations 读取可与项目后台命令重叠。后台命令可能写入，项目文件操作仍需等待或取消该命令，两个任意 shell 命令不自动并发。Session 在发布 invocation 完成/让出前排空受管进程；若模型未完成命令就结束，终止并收尾后返回失败，不把后台工作算作成功。不能确认终止时拒绝封存；这些措施仍不构成任意 shell 外部副作用的容器隔离。

受管命令退出后，日志尚未保存时返回 `flushing`，仍占有工作区；使用 `write_stdin` 继续等待。`cancel_process` 分别等待进程关闭和日志收尾，各等待窗口为 5 秒；进程已退出而日志仍在排空时返回 `flushing`，不误报进程终止失败，也不发布部分日志。invocation 收尾再等待最多 60 秒保存日志，超时明确报日志排空失败并拒绝封存；真实写入失败仍致命。日志在既有脱敏及 16 MiB 上限内合并写入。见[日志收尾决策](../decisions/accepted/2026-10-19-managed-process-log-drain.md)。

输出按增量分页返回，待消费缓冲最多 1 MiB；脱敏日志最多 16 MiB，超长行省略。两者的 truncated 与 logTruncated 分别报告，属于诊断资源保护，不是请求次数额度。Recovery 将终态日志提交为 `recovery_process_output` artifact，并记录 `recovery.process_log_committed`，避免 staging 清理后日志引用失效。新增参数、输出和日志引用继续通过工具与 artifact 事件复原。

Recovery 按 opt-in 注册 apply_patch 和 view_image，不改变 Comparison 的共享工具默认面。apply_patch 复用静态补丁解码与受控写入 journal，支持普通文件 Add/Update/Delete，所有目标与上下文在写入前预检，保留 CRLF；Move、无已有上下文的纯插入暂不支持。格式/上下文错误可纠正，真实 I/O 或部分写入失败仍终止。view_image 复用 read(format=image) 的 native image blocks、尺寸限制和 allowBinary 权限，图片路径文字不等于模型看图。

stdout、stderr 各自增量解码 UTF-8，并分别维护输出脱敏状态，再汇合已脱敏内容；另一管道的换行不能结束本管道尚未完整到达的敏感记录。脱敏发生在分页、模型交付、事件审计与日志写入之前。可能的凭据前缀和未结束值延迟交付，完整记录使用共享脱敏规则，普通交互提示仍可即时返回。敏感待定记录超过 64 Ki 字符时省略并标记截断，命令结束仍未闭合的敏感记录也省略。参数及完成事件统一使用共享规则，覆盖 JSON 凭据与 URL userinfo。日志持久化失败在 poll 和取消收尾中都保持致命，不因取消时序而消失。

## 隔离边界

共享 workspace 目录遍历将符号链接（含 Windows junction）明确列为 symlink 条目，不解析或递归目标，继续其他条目；find 保留其路径，grep 只读普通文件。受控路径经过链接仍被拒绝，非普通文件目标与过大的 edit/write 内容可由模型纠正；Controller 返回结构化拒绝，Recovery/Comparison 沿原生工具错误继续。未知 I/O、审计与写后完整性故障仍致命。目录查询保持既有深度/数量限制，不套用快照依赖排除策略。见[目录与文件前置条件决策](../decisions/accepted/2026-10-15-workspace-link-listing-and-file-preconditions.md)。

Briefing 中的 source Git 事实来自准备时对 source 的既有探测，只提供 repository、HEAD、指定历史 commit 对象是否存在及 status 是否可用；未成功取得的事实保持 unknown。它们不是工作副本当前 Git 状态，也不证明历史任务前起点。事实进入 `recovery.model_input` artifact，并随模型可见文本进入既有请求审计。

共享 Pi Provider 以连续失败而非整轮 `continue()` 次数限制瞬时网络/上游错误：一次成功模型 turn 后重置计数，无成功进展时最多三次请求，退避依次为 2 秒和 4 秒。失败响应中的部分文本不算进展，已完成工具不会重放；context overflow 仍只允许一次缩减恢复，取消、原截止、致命工具与审计失败优先。失败诊断保留脱敏的 HTTP/TLS 原因；这些恢复措施不代表上游网络已经可用。见[可靠性决策](../decisions/accepted/2026-10-12-recovery-progress-aware-retries-and-briefing.md)。

Recovery 工具以工作副本为 cwd，受控文件写入限制在该根内。source/、observations/、playbook 只读；Host 通过路径边界、source 写锁和 fingerprint 保护 source。候选运行随后从接受的 baseline 准备独立副本，Runtime 启动上下文声明 `workspace: isolated`。Git sink、捕获 artifacts 和 cleanup 都归 Harness 管理。

`source/`、`workspace/` 和其他合法相对目录路径允许单个尾斜杠；空中间段、`..`、绝对路径仍拒绝。source/ 与 observations/ 是文件工具虚拟前缀；shell 以工作副本为 cwd，只通过既有 `REPRISE_SOURCE_MOUNT` 访问 source。observations 不提供 shell 挂载，只能用 `ls`、`find`、`grep`、`read` 读取；不把文本命令守卫当成对任意外部路径的文件系统隔离。

本机 shell 隔离不是全局容器沙箱；凭据目录、全局配置和外部系统不在恢复能力内。Windows 11 是已验证平台，Recovery 工具自己的 shell 发现链不能与通用 Runtime spawn 规则混为一谈。

受控 edit/write 在开始及原子提交前检查取消；Session close/cancel 等待 Provider 工具与审计收尾后才记录会话终态，工作区释放不得越过收尾边界。精确编辑原文缺失或不唯一仍作为工具错误审计并允许模型纠正；真实文件系统、journal 与审计故障保持调用失败。见[工具取消与编辑前置条件](../decisions/accepted/2026-10-08-agent-tool-cancellation-and-edit-preconditions.md)。

## 接受与 Git 安全

[收尾流程](../../src/application/recovery/run-finalize.ts) 先验证 Provider 结果，再执行任务前 HEAD 检查；只有 ready 且未被该机械闸门阻挡才自动接受。blocked 保留为缺关键输入，任务前检查失败为 blocked_by_safety，二者不能混同。路径存在或测试通过不证明历史起点等价。

Git remote 在 Harness 拥有的树内改写至本实验 sink，禁止为补齐对象触发 lazy fetch；对象不完整也不能跳过 remote 保护。sink 的 initial refs 来自所观察的工作树，sink 隔离不代表其中内容已经是任务前状态。树内链接只按已验证边界处理，越界或无法解析的链接不跟随。NTFS 写锁和 source fingerprint 是保护与检测手段，不是对任意 shell 外部副作用的完整撤销机制。

[LocalWorkspaceProvider](../../src/environment/local-workspace-provider.ts) 拥有 staging、checkpoint、accept 与副本生命周期；[Recovery Agent](../../src/agents/recovery-agent.ts) 拥有调查和结论；[编排](../../src/application/recovery/orchestrator.ts) 拥有 created → staged → forensics → model → validated → accepted/failed 生命周期。具体 Git 不变量见[隔离决策](../decisions/accepted/2026-09-11-git-isolation-invariants.md)。

## 冻结观察导航与报告边界

冻结观察 JSON 保留完整隐私处理后内容；`read` 使用字节 offset/maxBytes 翻页，截断正文含 nextCursor。读取不存在、访问拒绝、空文件和 EOF 均有不同文本反馈；未知 I/O、安全边界和审计故障不降级成“未找到”。旧 excerpt envelope 原样兼容，已丢失尾部不伪造。

`observations/timeline/INDEX.tsv` 按冻结 transcript 顺序列出编号 `.txt` 路径，消息、工具命令和结果不再需要多层 JSON 解码；每条仍指向原 transcript JSON。完整 INDEX.tsv 保留，`index-pages/0001.tsv` 起每页 100 个精确 catalog 路径。导航只提供事实，不选择 Git 起点。

Agent 负责选点和恢复工作树，不需要手工清理 Git refs/reflog/对象；Host 统一封存并记录 `recovery.history_sealed`。外置报告分别保留封存前 Agent 判断和封存后 Host 机械状态，不把历史语义包装成机械验证通过。taskReadiness 无额外路径或命令检查时明确披露检查为空；ready 不证明依赖、build 或完整原任务已经验证。
