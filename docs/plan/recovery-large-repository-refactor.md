# Recovery 大仓库按需恢复重构计划

状态：proposed

本文解决大型仓库在 Recovery 开始前因完整复制触发 `source_budget_blocked`、导致 Agent 未启动的问题。它是统一 Recovery 流程的工作区准备补充，不是按任务类型分流。实施 Agent 必须同时阅读[Recovery Agent 模块重构实施计划](./recovery-agent-refactor.md)、[Recovery 起点恢复目标](./recovery-initial-environment.md)、[Environment 架构](../architecture/environment.md)和仓库根部 `AGENTS.md`。

## 1. 问题定义

当前流程把整个当前源目录复制到 staging，然后才让 Recovery Agent 调查和恢复。大仓库中的 `node_modules`、构建产物、缓存、生成目录和其他可重建内容会先消耗复制预算；预算超限时 Provider 直接失败，Agent 没有机会判断任务实际需要什么。

该流程混淆了三个概念：源目录是历史任务结束后的材料，Recovery 工作区是 Agent 的操作空间，baseline 是 Agent 判断后的任务起点。完整复制源目录不应是 Recovery 启动的必要条件。

## 2. 目标

- 源目录过大时，Recovery 仍能启动并自主判断恢复范围。
- Recovery 可以读取当前用户源目录本身，但只能以只读方式读取；源目录不作为 Agent 的写入工作区。
- observations、TaskCase、Git、preimage 和历史材料继续提供，但只是辅助证据，不能替代源目录调查。
- Recovery 工作区可以从空目录、稀疏副本或小型起点开始；Agent 按需复制、恢复、删除、重建和安装。
- 最终 baseline 只包含任务条件需要的内容，不要求复制整个仓库。
- 大仓库的不可复制部分不再被直接解释为“无法恢复”；只有影响任务的缺口才导致 `blocked`。
- 保留现有七个通用工具，不新增大仓库专用业务工具或恢复 DSL。

## 3. 核心模型

```text
用户源目录（只读、可很大）
        │
        ├── 只读 source mount：Agent 按需调查
        ├── observations / Git / preimage：辅助证据
        │
        ▼
Recovery 工作区（可写、轻量或稀疏）
        │
        ├── Agent 按需复制和恢复任务所需内容
        ├── Agent 清理后继成果
        ├── Agent 按需准备依赖和工具
        │
        ▼
封存 baseline（任务起点）
        │
        ▼
每个候选的独立运行副本
```

源目录、工作区和 baseline 必须拥有不同的路径身份。不能让 `shell_exec` 的当前目录指向用户源目录，也不能通过符号链接、junction 或环境变量绕过只读边界。

## 4. 目标代码架构

### 4.1 Environment Provider

`LocalWorkspaceProvider` 负责：

- 检查源目录可访问性、路径身份和源目录 tripwire；
- 创建轻量 Recovery 工作区；
- 建立只读 source mount 的逻辑路径；
- 提供可按需读取的源目录视图；
- 复制单个文件、目录或明确的受控范围；
- 对工作区做 fingerprint、预算检查和 baseline 封存；
- 在封存前清理 `.reprise/recovery-work/` 和报告临时文件。

Provider 不负责决定哪些文件属于任务起点，也不要求先计算完整源目录 fingerprint 才能启动 Agent。源目录扫描应支持有限摘要、按需路径读取和遇到预算时的可诊断降级。

### 4.2 Recovery Agent

Recovery Agent 继续使用一个连续 Session、一个工作区和三个 turn。它同时看到：

- 可写工作区；
- 只读源目录视图；
- observations、Git/history 和 preimage 入口；
- 原始任务和时间边界。

Agent 自己决定从源目录读取什么、把什么复制到工作区、什么需要恢复旧内容、什么属于后继成果、什么依赖必须重建。预先抽取的 facts 不得成为探索范围的上限。

### 4.3 Workspace Tools

保留 `read`、`ls`、`grep`、`find`、`edit`、`write`、`shell_exec`。工具需要支持两个明确的逻辑根：

- `workspace/`：默认可写根，`edit`、`write` 和 shell cwd 只能作用于此处；
- `source/`：用户源目录只读根，`read`、`ls`、`grep`、`find` 可按需读取。

如果继续使用单一相对路径接口，应在工具层提供两个已注册的工作区挂载根，而不是允许 Agent 传入用户绝对路径。路径语法、符号链接、junction、大小写和 Windows 分隔符必须在工具边界统一处理。

## 5. 启动策略

### 5.1 小型源目录

源目录在预算内时，可以复制为初始工作区，复用当前简单路径。Agent 仍需判断后继内容，不得把复制结果当作起点。

### 5.2 大型源目录

源目录预计超预算或完整复制失败时：

1. 创建空或仅含必要元数据的工作区；
2. 建立只读 source mount；
3. 写入小型目录摘要和观察入口；
4. 启动 Recovery Agent，不因源目录总量超预算失败；
5. 由 Agent 按需读取并复制任务需要的内容；
6. 对工作区而不是整个源目录执行最终预算、fingerprint 和封存检查。

无法建立只读 source mount 时，只有在已有 checkpoint、Git/preimage 或其他材料足以完成任务条件恢复的情况下继续；否则返回 `blocked`，并说明源目录不可观察是关键缺口。

### 5.3 目录摘要

摘要是导航，不是事实全集。它应提供可用的顶层目录、预算是否估算、明显的大目录提示和 source mount 入口，但不在首包中展开整个树。Agent 需要具体内容时通过 `ls`、`find`、`grep`、`read` 读取。

## 6. 三轮 Agent 编排

### Turn 1：理解与侦察

Agent 先理解原始任务和起点边界，然后同时检查工作区、source mount 和辅助 observations。重点是找出任务所需的源文件、配置、输入、依赖和可能的后继成果。它不需要遍历整个大型仓库，也不需要复制尚未证明相关的目录。

### Turn 2：按需恢复

Agent 把需要的内容从 source 复制或从 Git/history 恢复到工作区，清除任务期间及之后产生的成果，按需安装依赖、生成配置、构建或运行测试。它自行判断环境准备与原始任务的边界。

### Turn 3：自检与结论

Agent 只检查任务所需条件和可能影响候选的残留内容。它可以继续读取 source 并修补工作区。最终写 `recovery.md`，返回 `ready` 或 `blocked`。工作区过大、某个无关目录无法复制本身不构成 blocked；关键输入、代码或运行条件无法获得才构成 blocked。

## 7. 输入和 Prompt 调整

System Prompt 增加以下稳定事实：

- 当前用户源目录可通过只读 source mount 按需读取，可能远大于工作区预算；
- 工作区是唯一写入和 shell 执行根；
- observations、Git/history 和 preimage 是辅助材料，不能假定完整；
- 不要为了复制完整仓库而停止，按任务需要选择内容；
- source 中的后继成果仍按起点恢复规则处理。

System Prompt 不加入固定任务资源清单、整仓库扫描步骤、预算评分或 source 文件列表。三个 turn prompt 只补充当轮目的；第一轮提供 source mount 和摘要入口，第二轮强调按需复制/恢复，第三轮强调任务条件自检。

## 8. 状态和持久化

- 源目录访问、读取路径和复制动作进入现有 Agent audit 与事件日志；不把完整源目录内容塞进事件或模型首包。
- 复制到工作区的文件由工作区 fingerprint 和受控写入记录保存；Agent 的推断仍通过报告和 Session 上下文表达。
- `.reprise/recovery-work/` 位于工作区，只保存 Agent 自己的临时记录；封存前清理。
- baseline fingerprint 只描述封存后的任务起点，不要求等于源目录 fingerprint。
- 源目录 tripwire 仍在恢复前后执行，确保 Recovery 没有修改用户目录；source mount 的只读属性应由 Provider 在创建时建立，并在结束时复核。

## 9. 大仓库预算规则

- 源目录总文件数、总字节数和单文件大小只影响“能否整体复制”，不直接决定 Recovery 是否可以启动。
- 工作区仍受预算限制，避免 Agent 按需复制后再次生成不可控 baseline。
- 单个超大文件只有在 Agent 判断其影响任务且无法用范围读取或重建替代时才进入工作区；否则记录为缺口或跳过。
- `node_modules`、构建输出、缓存、生成目录和工具元数据不默认复制，由 Agent 按任务需要保留或重建。
- 不为了满足预算而静默截断源码、锁文件或任务输入；截断必须变成可观察的缺口。

## 10. 实施步骤

### 阶段 A：路径与 Provider 能力

1. 将 sourceRoot 和 workspaceRoot 分离为明确的 Provider-owned 路径。
2. 实现 source mount 的只读访问和按需目录摘要。
3. 使完整源目录预算失败降级为 sparse staging，而不是直接失败。
4. 增加 source tripwire、符号链接/junction 和绝对路径边界测试。

### 阶段 B：工具和 Prompt

1. 让七个工具区分 source 只读根和 workspace 可写根。
2. 更新 Recovery System Prompt、三个 turn prompt 和 Codex/Claude Playbook。
3. 删除要求完整复制、默认保留当前无关文件或依赖 Host 候选的旧文字。
4. 保证 source 读取按需发生，首包只保留任务、边界、摘要和入口。

### 阶段 C：单副本 Agent 编排

1. 让大型源目录直接进入一个 Session 和一个 sparse workspace。
2. 删除完整源目录复制作为 Agent 启动前置条件。
3. 删除多候选、候选选择、预设 hypothesis 和独立业务 Verifier。
4. 机械检查失败时反馈同一 Session；不因源目录总量再次重启调查。

### 阶段 D：封存和复用

1. 只对最终 workspace 做 fingerprint、预算和 baseline 封存。
2. 清理临时记录、报告和未迁移的 Recovery 工作材料。
3. 后续运行从 baseline 复制独立副本；必要条件缺失时做轻量修补，不重新读取整仓库。
4. 为“源目录很大但任务范围很小”和“关键输入位于大目录深处”分别增加 fixture。

## 11. 验证

每次源码修改后先 `npm run build`，测试读取 `dist/`。新增或修改的门禁必须配反向测试。至少覆盖：

- 大于复制预算的源目录仍创建 sparse staging 并启动 Recovery；
- Agent 能从 source mount 读取深层任务文件并复制到 workspace；
- source mount、用户源目录和 observations 均不可写；
- 无关超大目录不复制不阻塞，关键超大输入缺失会 `blocked`；
- 任务成果清除、旧文件恢复和必要依赖按需重建；
- `.reprise/recovery-work/` 清理及必要内容迁移；
- baseline 只从最终 workspace 封存并可被多个候选独立复用；
- source tripwire 检测真实源目录变化；
- Windows 绝对路径、反斜杠、junction、symlink 和长路径边界；
- `npm run check` 和 `npm run verify:docs`。

## 12. 不应采用的修复

- 仅提高 5 万文件 / 1GB 上限；
- 直接跳过预算并完整复制，等待后续失败；
- 把 `node_modules`、缓存或构建输出全部排除后假定所有任务都能运行；
- 为大仓库新增一套专用 `copy_file`、`inspect_source` 或候选选择工具；
- 让 Agent 的 shell cwd 指向用户源目录；
- 用 source mount 的目录摘要替代真实按需读取；
- 通过 Host 证据评分决定 Agent 是否恢复成功。

## 13. 完成条件

当大型源目录不再在 Agent 启动前因整体复制预算失败，Recovery 能读取只读源目录并在单工作副本中按需建立任务起点，最终 baseline 可复用，且所有相关测试和门禁通过时，本重构目标才算完成。仅测试了小型复制路径或提高了预算，不构成完成。
