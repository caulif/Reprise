# Recovery 起点恢复目标

本主题承接用户已确认的[需求决策](../decisions/proposed/2026-09-09-recovery-initial-environment-requirements.md)。当前行为见[环境规范](../architecture/environment.md)；本文描述目标及实施差异，不改变现行运行权限。

## 相关文档索引

设计入口是本文与[环境架构](../architecture/environment.md)。角色提示词边界见[Agent 职责与提示词](../architecture/agent-roles-and-system-prompts.md)，跨模块所有权见[架构总览](../architecture/overview.md)，持久化事实见[持久化与崩溃一致性](../architecture/persistence-and-crash-consistency.md)，运行结果边界见[结果与终止](../architecture/run-outcome.md)，安全与可比性见[验证边界](../architecture/validation.md)。

恢复专门的实施路线在[重构执行计划 M2](./reprise-refactoring-execution.md)与[Recovery Agent 重构](./recovery-agent-refactor.md)。当前规则是[自主三轮循环](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md)、[连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)、[工作集与观察文件](../decisions/accepted/2026-09-07-recovery-working-set-and-observation-files.md)和[checkpoint 恢复](../decisions/accepted/2026-08-18-recovery-checkpoint-restore.md)。

## 职责

Recovery 自主调查当前隔离环境和历史材料，重建原任务开始前的任务条件。清理、保留、恢复和按需重建由 Agent 判断，不为每个文件设计评分或额外审批流程。结果提供简短恢复说明、剩余缺口和是否可以开始候选任务的结论。

主流程只有一个连续 Recovery Session 和一个隔离工作副本。Host 提供证据和工具并保存结果，Recovery 自主推进调查、恢复和自检，不预先生成多套候选。Recovery 决定缺口是否影响任务；Host 只拦截机械失败，并把可修复事实反馈给同一 Session。

最终输出只保留 `ready` 或 `blocked`，并附简短报告和 `unresolved`。输入只包括任务、起点线索、可观察材料和能力边界；Host 不预设假设或候选路线。

Recovery 不增加 Todo、Plan 或 Goal 工具，也不维护复杂业务状态机。Agent 只需在 Session 摘要中维护当前目标、已完成动作、待检查项和阻塞原因。Host 保留运行生命周期状态，用于控制 Session、审计工具、处理取消和超时、检查边界并保存基线。

目标包含完整目录中的必要内容，不要求复制整台历史机器。修复任务的 bug 应仍然存在，生成任务的成果应尚不存在。依赖可按需安装，不能为了通过检查而预先完成原任务。

## 本机环境与复用

用户确认允许复用并按需修改本机开发环境，不要求容器或虚拟机。任务文件在隔离副本内恢复，本机依赖与工具配置可按需调整，变化不会因删除副本而自动撤销；凭据保护与全局 Git 配置限制继续有效。

恢复起点保存后，每次运行复制独立副本。复用前轻量检查必要运行条件；正常直接启动，发现必要环境缺失才交给 Recovery 修补运行副本或本机依赖，不重新反推整个目录，也不修改保存的起点。具体检查入口和记录方式另行设计。

## 实施差异

| 入口 | 要求 |
|---|---|
| [系统提示词](../../src/agents/recovery-agent.ts)、[Codex Playbook](../../src/products/packs/codex/recovery/SKILL.md)、[Claude Code Playbook](../../src/products/packs/claude-code/recovery/SKILL.md) | 同步起点时间与降级边界；允许主动反推、整体清理和必要环境重建；替换无关当前文件默认保留的规则。 |
| [调查与候选](../../src/application/recovery/investigation.ts) | 证据是调查材料，已有 patch 或预设候选不能成为探索上限；复用现有工具循环。 |
| [就绪检查](../../src/application/recovery/readiness.ts)、[Verifier](../../src/application/recovery/verifier.ts) | 路径存在、发生变更或测试通过不是起点等价的充分条件；零变更也可能正确。机械检查不替 Agent 决定缺口的任务影响。 |
| [发布流程](../../src/application/recovery/run-finalize.ts)与候选启动 | Agent 判断缺口影响任务则停止，不影响则继续；结构合法性、隔离和持久化完整性仍由 Host 验证。prompt、结果协议和启动判断在同一实施批次同步。 |

## 验收

## Agent 编排草案

1. Host 建立 staging、只读 observations 和一次 Recovery Session，输入任务句、时间边界线索、当前目录摘要及可用工具。
2. Recovery 先理解任务和起点，再检查当前目录；按需读取历史、Git、preimage、补丁和运行环境信息。
3. Recovery 在同一副本内恢复旧文件、清理后继成果、重建必要依赖或配置，并自检；是否执行准备动作由任务语义决定，不能替候选完成原任务。
4. Recovery 给出“可开始/不可开始”和简短缺口说明。Host 只校验边界、结果格式、只读材料未被修改和基线可保存。
5. 机械校验失败且可修复时，将具体失败事实反馈给同一 Session；不可修复或关键缺口影响任务时停止。
6. 可开始时封存起点。后续运行复制独立副本；只做轻量运行条件检查，缺失时修补运行副本或本机环境，不修改封存起点。

现有多候选假设、独立 Verifier 评分和把零变更视为失败的逻辑，需要在实施批次中重新审查；本草案不宣称代码已经符合。

最小循环示意：

```text
理解目标 → 调查/操作 → 读回验证 → 更新短摘要 → 继续或给出 ready/blocked
```

## Agent 上下文与状态

- **上下文预算**：首包优先任务句、起点边界和当前任务最相关的摘要。
- **Just-in-time retrieval**：历史 transcript、事件和文件按需读取，不在启动时塞入完整仓库或 catalog。
- **压缩与摘要**：长 Session 只保留任务目标、不变量、已验证事实和未决问题，工具原文按引用留存。
- **状态管理**：持久事实、临时思路、工具输出和任务进度分别保存；压缩或重试不能把临时思路伪装成事实。

## Prompt 设计

System Prompt 只承载跨任务稳定规则：恢复目标时点、证据使用、后继内容处理、环境准备与原始任务的区分、未知与缺口的处理、可用工具和临时记录边界。它不规定某个任务必须具备的资源，不规定三轮具体动作，也不包含最终 JSON 输出格式。

三个 turn 固定为默认编排，但 prompt 结构分别服务于当轮目标：

1. **理解与侦察**：提供原始任务、时间边界、当前摘要和历史入口；Agent 推导起点条件，按需调查，识别后继内容和待确认问题。
2. **恢复与准备**：承接上一轮上下文；Agent 自主调查、清理、恢复、重建和准备运行环境，同时保留原始任务本身。
3. **自检与结论**：Agent 自行选择检查方式，修复可安全修复的问题，判断缺口是否影响任务，写报告并按本轮输出契约返回 `ready` 或 `blocked`。

每轮都可以使用工具、调查、修改或验证；三轮是固定交互次数，不是由 Host 强制执行的业务状态机。Session 原生上下文负责连续承接；Agent 可在需要时把关键目标、已完成动作、待检查项和阻塞原因写入工作副本的 `.reprise/recovery-work/`。该目录是临时工作材料，不进入封存基线；Agent 可将其中必要内容迁移到正常路径。

输出契约由 Host 在最后一轮的结构化请求中提供，System Prompt 和前两轮 prompt 不重复定义。

- 新增成果与解题笔记清除，旧输入恢复，必要依赖按需保留或重建。
- 隐藏目录或缓存会暴露后继答案时处理；不影响任务时不盲目重建。
- 没有完整 patch 时仍利用当前文件与历史主动调查重建，推断不冒充原件。
- 关键输入无法恢复时停止，无关缺口允许继续并说明原因，不逐文件打分。
- 已处于起点的目录可零变更继续；恢复 bug 任务不以修好 bug 或所有测试通过为成功标准。
- 用户源目录与只读证据保持不变，恢复基线可供独立候选复用。
- 复用正常时不调用 Recovery；必要环境缺失时只修补运行条件，保存的起点保持不变。

这些是后续实现的行为验收条件，文档校验不证明它们已满足。
