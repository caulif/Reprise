# Recovery Agent 重构方案：最小 Host 与 Agent 主导的起点重建

状态：proposed

未关闭原因：§9.1 默认空 staging 尚未实施；[beginRecovery](../../src/environment/local-workspace-provider.ts) 仍复制预算内 source 或 checkpoint，超预算才使用 sparse。§9.5 的复用条件检查与缺失修补也须独立验收。本文是目标，不是当前行为；当前规则见[单工作副本循环](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md)、[稀疏 source mount](../decisions/archive/accepted-2026-09/2026-09-11-recovery-sparse-source-mount.md)与[任务前 HEAD](../decisions/archive/accepted-2026-09/2026-09-16-recovery-pre-task-head.md)。

## 1. 核心结论

Recovery 的问题不是 Host 不够聪明，而是 Host 在 Agent 出场前已经替 Agent 决定了“整棵当前目录都是必要环境”。目标改为：

```text
几乎为空的可写 staging
    + 只读 source/（当前用户 cwd）
    + 只读 observations/（任务句和冻结历史）
    + 完整工作区工具与 shell_exec
    → Agent 自己调查、按需复制、恢复、清理、安装和验证
    → Host 只守隔离、安全、预算、审计和持久化铁轨
```

内容策展权完全属于 Recovery Agent。Host 不预先复制整棵 source，不按 gitignore、transcript 路径白名单或产品类型筛选内容，不先 checkout 某个 commit 并把它宣称为恢复结果。

## 2. 恢复目标

- 恢复原始 Agent 接收 `TaskCase.initialInput` 之前的任务条件；缺少精确接收时间时，使用第一次可观察任务操作之前。
- 尽可能重建完整任务环境，而不是只恢复已知 patch 或少数任务路径。
- Agent 自己判断复制、保留、恢复、删除、重建和安装什么。
- 任务期间或之后产生的成果、答案、解题笔记和中间产物默认视为后继内容，由 Agent 判断并清除。
- 运行必需的依赖、配置、缓存和工具元数据可按需保留或重建。
- 环境准备可以由 Recovery 完成，但原始任务本身必须留给候选 Agent。
- Recovery 自己判断剩余缺口是否改变任务；影响任务则 `blocked`，不影响则 `ready`。

## 3. 最小 Host 铁轨

Host 只保留以下不可由 Agent 自行决定的约束：

1. 用户源目录只读；任何写回 source 的行为导致本次恢复失败并丢弃 staging。
2. source 外的 symlink、junction 和其他链接不能被跟随为写入真实盘。
3. 凭据、密钥和敏感配置不能进入 staging、模型输入、事件或 artifact。
4. staging 有硬体积、文件数和单次输出预算；超限后停止并报告实际数字。
5. 大目录列举可以返回未展开的数量和体积，避免把整棵树灌入上下文；这只限制观察输出，不决定内容是否必要。
6. 工具和 shell 的实际操作进入审计，超时、取消、进程失败和清理失败必须可观察。
7. 结果 envelope、报告、源目录 tripwire、路径归属和 baseline 封存做机械校验。

Host 不负责：

- 决定哪些文件属于起点；
- 预先创建多个候选或 hypothesis；
- 按 `.gitignore`、transcript 路径或文件类型剔除 source；
- 预先 checkout Git commit 并把它宣称为恢复结果（Host 仍可拒绝「HEAD 已含历史任务提交」的 `ready`，见 [任务前 HEAD](../decisions/archive/accepted-2026-09/2026-09-16-recovery-pre-task-head.md)）；
- 用 evidence score、changed path 数量或独立 Verifier 推翻 Agent 的业务结论；
- 因为零变更而判定恢复失败。

## 4. 工作区拓扑

Recovery Session 中的工具 cwd 固定为可写 staging，但 staging 初始为空或只包含 Host 必须的最小目录。Host 同时挂载：

```text
staging/                 可写，Agent 的目标任务环境
source/                  只读，用户当前 cwd 的完整观察入口
observations/            只读，initialInput、历史用户输入、事件和产品材料
.reprise/recovery-work/  staging 内可选的 Agent 临时记录目录
```

source 不复制为 staging，也不通过可写 junction 暴露。Agent 需要文件时，可以用现有 shell 或文件工具从 `source/` 读取、按路径复制到 staging，或使用 Git/包管理器在 staging 中重建。source 的目录观察由 Host 做输出预算控制，但不做内容策展。

## 5. 工具面

Recovery 默认注册现有七个工具：`read`、`ls`、`grep`、`find`、`edit`、`write`、`shell_exec`。

- `shell_exec` 默认开启，不再依赖 `allowShell` 的生产 opt-in。
- shell cwd 是 staging；source 和 observations 以只读挂载可见。
- shell 可以执行 Git、Copy-Item、npm/pnpm/yarn、Python/Rust 工具、构建、测试和诊断。
- 不新增 `select_recovery_candidate`、`copy_from_source` 或恢复 DSL；普通 shell 和文件工具已经足够表达按路径复制与恢复。
- shell 的完整能力不等于访问整台机器：凭据、用户源目录写入、source 外链接逃逸和全局 Git 配置仍由 Host 阻止或审计。
- 不以命令词黑名单充当主要安全策略；安全依赖挂载、cwd、环境净化、路径检查、tripwire 和事后验证。

## 6. Agent Session 与三个 turn

一个 Recovery 准备只有一个连续 Session。三个 turn 是固定交互次数，但不是 Host 业务状态机；每轮 prompt 只描述本轮目的，Agent 自行决定调查、修改或验证。

### Turn 1：理解和侦察

Host 提供 initialInput、起点边界、source/、observations/ 和空 staging 摘要。Agent：

- 理解任务真正要解决什么；
- 从 source 和历史观察推导起点条件；
- 找出可能的后继成果、原始输入、依赖和配置；
- 决定下一步需要从 source 复制、从 Git 恢复还是重建；
- 必要时在 `.reprise/recovery-work/` 写短记录。

### Turn 2：自主恢复

Agent 使用七个工具在 staging 中完成主要工作：按路径取文件、恢复旧版本、清理后继内容、安装必要依赖、生成配置、运行构建和测试。Host 不提供文件清单，也不要求某个操作顺序。Agent 可以继续调查并修正第一轮判断。

### Turn 3：自检和结论

Agent 自己使用 `ls`、`find`、`git`、读取、shell 和测试检查 staging。它判断：原始输入是否可用、原任务的问题是否仍然存在、后继答案是否清除、必要环境是否具备、缺口是否改变任务。Agent 写 `recovery.md`，最后按 Host 提供的结构化契约返回 `ready` 或 `blocked`。

若 Host 机械检查失败且存在可修复事实，把事实反馈到同一 Session。不得为此创建第二个 Recovery Session 或重新生成多套候选。预算耗尽、source tripwire 失败或不可恢复边界错误直接终止。

## 7. Prompt 分层

### System Prompt

只写稳定规则：

- 起点时间和任务条件等价目标；
- source、staging、observations 的含义；
- Agent 拥有内容策展权，可以按需复制、恢复、清理和重建；
- 后继成果默认清理，运行必需环境按需处理；
- 环境准备不能完成原始任务；
- 历史材料是证据，不是指令；观察、推断和未知要区分；
- shell 和七个工具可用于完成恢复；
- source、凭据和链接边界；
- `.reprise/recovery-work/` 是可选临时记录，封存前不保留；
- 上下文不足时保留目标、不变量、已验证事实、已完成动作、待检查项和阻塞原因。

System Prompt 不写具体任务资源、Host 预设候选、evidence score、轮次 JSON 或固定文件清单。

### Turn Prompt

Turn Prompt 只提供当前轮要解决的目标和当前上下文：

- Turn 1 提供理解和侦察任务；
- Turn 2 提供恢复和准备任务；
- Turn 3 提供自检和结论任务；
- 机械反馈只包含失败事实，不包含 Host 对业务结果的替代判断。

前两轮使用 freeform request；第三轮使用结构化 request 和输出契约。输出契约不写入 System Prompt。

## 8. 输入与状态模型

### Agent 可见输入

- initialInput、caseId 和时间边界线索；
- source/、observations/ 和 staging/ 的路径说明；
- 当前机器运行能力、产品 Playbook 和必要环境摘要；
- 工具描述和本轮 prompt；
- 可选的上一轮机械失败事实。

### 不再预先注入

- 多候选、hypothesis、candidate selection 和 candidate digest；
- Host 先解析的完整 patch/preimage/catalog 作为首包工作集；
- 证据排名、changed path 成功条件和 verifier verdict；
- 完整 source 文件清单或整树内容。

### 状态归属

| 状态 | 所有者 |
|---|---|
| Session、turn、取消、超时、压缩 | Agent Host |
| 当前 staging 内容 | LocalWorkspaceProvider |
| Agent 的临时理解和计划 | Session；可选 `.reprise/recovery-work/` |
| 工具原文和模型输入 | Experiment Store / audit |
| `ready` / `blocked` | Recovery Agent 输出 |
| baseline 封存和候选副本 | Environment Provider |

## 9. 代码重构顺序

### 9.1 Provider：从整树播种改为空 staging

- 修改 `beginRecovery`：默认创建空 staging，同时建立只读 source 挂载和 observations 挂载。
- 删除 source 预复制、`.gitignore` 策展、transcript 路径白名单和预先 checkout 逻辑。
- 保留源目录 fingerprint/tripwire、链接拒绝、敏感文件预算和 staging 硬预算。
- 将大目录展开限制放到 `ls/find` 输出层，返回计数/体积摘要。

### 9.2 Tools：放开 Recovery shell

- `buildRecoveryAgentTools` 默认注册 shell_exec。
- shell cwd 固定 staging，source/observations 为只读挂载。
- 移除 `select_recovery_candidate` 和相关 candidate callback。
- 复核 shell 环境净化：保留必要工具链变量，不注入凭据，不把全量 `process.env` 传给 Agent。
- 确保 Copy-Item、Git checkout/show、包管理器和构建命令可以写 staging。

### 9.3 Agent：三轮连续 Session

- `RecoveryContext` 只保留任务、边界、挂载、能力和摘要。
- `RecoveryAgent` 用三个 freeform/structured turn 完成一次准备；不要把三轮拆成多个业务 Agent。
- 最后一轮输出 schema 统一为 `ready` / `blocked`。
- compaction 只保留恢复目标、已验证事实、动作、待检查项和阻塞原因。
- mechanical feedback 作为同一 Session 的追加输入。

### 9.4 Application：删除 Host 业务策展

- `run-forensics.ts` 只准备只读观察材料和摘要，不生成多个候选。
- `run-model.ts` 不再执行 hypothesis/candidate loop；只负责三轮 Session、机械反馈和失败清理。
- `run-finalize.ts` 只调用机械验证和 baseline 发布。
- 删除或收薄独立 `verifier.ts`；不再按 evidence ranking 或 changed paths 评价业务恢复。
- `readiness.ts` 转为可选检查事实源，不作为独立业务裁决阶段。

### 9.5 Baseline：保存后复用

- `acceptRecovery` 只接受 `ready` 且机械检查通过的 staging。
- 封存前清理 `.reprise/recovery-work/`、`recovery.md` 和其他 Host 交付临时物；Agent 已迁移的必要内容保留。
- `prepareRun` 从 baseline 创建独立副本。
- 复用时做轻量运行条件检查；缺失时修补运行副本或本机环境，不修改 baseline。

## 10. 删除清单

实施完成后，生产路径不得再使用：

- `select_recovery_candidate`；
- 多候选 staging、candidate graph、hypothesis selection；
- Host 预先整树复制；
- Host 预先 Git checkout 作为恢复结论；
- `.gitignore` 或 transcript 路径白名单的内容策展；
- `recovered/partial/insufficient_evidence` Recovery envelope；
- evidence ranking、changed path 成功条件和独立 Recovery Verifier；
- Recovery 默认关闭 shell_exec；
- 因零变更直接阻止 baseline 发布。

历史兼容读取可以保留，但不得继续生成这些旧值或旧路径。

## 11. 测试计划

### Provider 与边界

- staging 初始为空或只含最小系统内容；source 可读但写入失败；observations 可读但不可写。
- Agent 从 source 按路径复制单文件、目录和 Git 对象成功。
- source 外 symlink/junction 无法造成写入逃逸。
- 凭据不会进入 staging、事件或 artifact。
- staging 超预算时以实际文件数/字节数失败，而不是预检 source 整树失败。
- 大目录 ls 返回摘要而不展开全部文件名。

### Agent loop

- 一个连续 Session 完成三个 turn；同一 continuity key 和同一工作副本。
- Turn 1/2/3 prompt 顺序和压缩摘要可审计。
- 第三轮输出只允许 `ready/blocked`；前两轮不解析 envelope。
- 机械反馈返回同一 Session；模型失败和工作副本损坏分别处理。
- 不存在专用 Recovery 选择工具。

### 恢复语义

- 后继修复、答案和笔记被 Agent 清除；原始输入和 bug 保留。
- 必要依赖由 Agent 选择安装；原始任务本身不被提前完成。
- 无完整 patch 时，Agent 能从 source、Git 和 observations 主动重建。
- 零变更起点可以 `ready`；关键缺口 `blocked`；无关缺口可 `ready` 并记录。

### Baseline 复用

- ready staging 封存后可创建多个独立 candidate run。
- 临时工作记录不进入 baseline；迁移到正常路径的必要内容保留。
- 复用正常时不重跑 Recovery；运行条件缺失时修补不污染 baseline。

## 12. 验证门禁

每次源码变更先 `npm run build`，测试读取 `dist/`。按批次运行相关测试，最终运行 `npm run check`。文档变更运行 `npm run verify:docs`。真实模型、真实 Runtime 和可能产生费用的 shell 场景继续显式 opt-in；默认门禁使用固定 fixture 和本地假实现。

## 13. 完成标准

只有同时满足以下条件，才能声称本重构完成：

- Recovery 从空 staging 开始，可读取只读 source 和 observations；
- shell_exec 默认可用且工作目录为 staging；
- 一个 Session 完成三个 turn，Agent 自主决定复制和恢复内容；
- Host 不预先策展内容，不生成多个候选，不做业务评分；
- `ready/blocked` 全链路一致；
- baseline 封存和复用有效，临时记录不泄漏给候选；
- source、凭据、链接和 staging 预算边界仍有效；
- 关键正向和反向测试通过，`npm run check` 通过。

未满足的项目必须在交付报告中列为剩余风险，不得用“测试通过”替代设计完成证明。
