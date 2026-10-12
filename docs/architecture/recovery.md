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

## Recovery Agent 三轮

一个 Recovery attempt 使用一个 Session 和同一工作副本，三个主要轮次。Recovery Agent 自己按提示词在每轮结束前写 `.reprise/recovery-work/notes.md`；Host 保存并在继续同一 Session 时重新提供该位置：

1. **understand**：优先使用 briefing 内的任务文本、source Git 探测事实和工作区摘要，读取 playbook，并按关键未知定位历史证据；任务被截断或存在具体疑问时再读完整任务文件。
2. **restore**：在工作副本内调查、复制、清理并验证必要输入；仅当恢复目标需要时准备环境，保持原任务未完成。
3. **conclude**：再次检查，写工作副本根部的 `recovery.md`，区分观察、推断、已执行动作和未解决项，返回 `ready` 或 `blocked`。

Host 的机械检查报告缺失文件、越界写入、source tripwire、schema 和报告格式问题；Recovery 编排在后续调用中把这些结果作为 `mechanicalFeedback` 传回 Agent。机械反馈和结构化修复可能增加模型请求，不能把三个主要轮次当成最多三次模型调用。有效结论缺少 recovery.md 时，Host 会根据 summary/unresolved 生成最小报告；报告缺失本身不必推翻结论。Agent 的一行 summary 原样进入 baseline 事实，Host 不另造证据评分。

`ready` 表示任务前输入已具备、候选可开始处理任务，不要求已经安装全部依赖或通过完整构建；非关键未知可以保留。`blocked` 表示继续需要猜测关键输入、任务条件或结果边界，且必须带 unresolved。Recovery 失败、取消、超时和无效输出都有 failure stage，不应伪造为成功恢复。

工具的确定性前置条件拒绝保留失败审计和模型可见错误，允许模型纠正后继续。同一 workspace broker 的 `edit` 在读取当前文件后，若 `oldText` 未命中或不唯一，会在 journal 和写入前以 `ToolPreconditionRejected(edit_text_mismatch)` 拒绝；不会因该拒绝锁存整轮致命失败。实际文件系统、symlink、受控写入、审计和完成回调失败仍终止 invocation，不把未知异常当作可恢复反馈。该规则也适用于使用同一 broker 的其他 Agent，详见[文本编辑前置条件决策](../decisions/accepted/2026-10-08-recoverable-edit-text-preconditions.md)。

## 受管命令与并行

Recovery 默认使用 `exec_command`、`write_stdin` 和 `cancel_process`。命令首次等待默认 10 秒，返回 running 与 invocation-owned 会话句柄后可继续获取新增输出；等待时间不是命令生命期，不再受旧 shell 默认 60 秒限制。旧 `shell_exec` 仍供未启用 managed execution 的调用方兼容使用。命令非零退出保留实际 exitCode，失效/越权句柄、工作区忙及编辑不存在的文件属于可纠正前置条件；审计、未知 I/O 和受控写入故障保持致命，并立即取消模型调用。

文件读取、列表与搜索可声明并行；后台命令可能写入，因此其存活期间拒绝其他冲突操作，模型必须先等待或取消。Session 在发布 invocation 完成/让出前排空受管进程；若模型未完成命令就结束，终止并收尾后返回失败，不把后台工作算作成功。不能确认终止时拒绝封存；这些措施仍不构成任意 shell 外部副作用的容器隔离。

输出按增量分页返回，待消费缓冲最多 1 MiB；脱敏日志最多 16 MiB，超长行省略。两者的 truncated 与 logTruncated 分别报告，属于诊断资源保护，不是请求次数额度。Recovery 将终态日志提交为 `recovery_process_output` artifact，并记录 `recovery.process_log_committed`，避免 staging 清理后日志引用失效。新增参数、输出和日志引用继续通过工具与 artifact 事件复原。

## 隔离边界

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
