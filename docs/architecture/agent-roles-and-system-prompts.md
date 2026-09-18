# Agent 职责与提示词维护

本文维护当前角色边界与 prompt 的代码入口，不复制可执行 prompt。未关闭 Recovery 目标见[起点恢复目标](../plan/recovery-initial-environment.md)与 [MASTER](../progress/MASTER.md)。

## 角色归属

| 角色 | 当前规范 | 可执行定义 |
|---|---|---|
| Recovery | [环境与恢复](./environment.md) | [Recovery Agent](../../src/agents/recovery-agent.ts)与[文本简报](../../src/agents/recovery-working-set.ts)；一次准备一个 Session、三轮委托，见[自主三轮循环](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md) |
| Controller | [协作行为](./controller.md)与[实验条件](./controller-experiment-conditions.md) | [Controller Agent](../../src/agents/controller-agent.ts)；连续 Session 先自由理解再决策，见[先理解再按视图决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md) |
| Comparison | [对照](./comparison.md) | [Comparison Agent](../../src/agents/comparison-agent.ts)；一次 attempt 一个 Session，理解/调查/创作/审阅，必要时恢复 Host 区域，审阅后交薄信封，见[可分享比较卡](../decisions/accepted/2026-09-09-comparison-shareable-task-card.md)、[可分享卡版式](../decisions/accepted/2026-09-14-comparison-share-card-layout.md)、[首屏清晰度与审阅改页](../decisions/accepted/2026-09-14-comparison-report-clarity-and-review.md)、[Host 区域与直接 HTML](../decisions/accepted/2026-09-13-comparison-host-zones-and-direct-html.md) 与 [单 Session](../decisions/accepted/2026-09-08-comparison-single-session.md) |

候选 coding agent 是 Product Pack 控制的外部产品，不是第四个内部模型角色。共享执行机制见 [AgentHost](../../src/infrastructure/agent/host.ts)，产品协议不进入内部角色。面向操作者的输出语言随 TUI locale（缺省 `zh`），三个内部角色按「正文、Workspace、语言块、可见过程」拼接 System Prompt；发给候选的消息跟随历史用户语言，见 [内部 Agent locale](../decisions/accepted/2026-09-15-internal-agent-locale.md)。结构化修复轮默认禁用工具，见 [修复轮禁工具](../decisions/accepted/2026-09-15-structured-repair-disables-tools.md)。Recovery 失败解释由 Host i18n 键或 Agent `summary` 承担，没有单独的 Diagnosis 角色，见 [删除 Diagnosis](../decisions/accepted/2026-09-15-delete-recovery-diagnosis-agent.md)。

## 提示词与权限

Recovery 的 prompt、三轮编排和发布判断见[起点恢复目标](../plan/recovery-initial-environment.md)、[可观察判断](../decisions/accepted/2026-09-11-recovery-observable-judgment.md) 与 [source ACL 与诊断 readiness](../decisions/accepted/2026-09-11-recovery-source-acl-and-diagnostic-readiness.md)。可执行 System Prompt、轮次委托、输出契约与压缩指令以 [`recovery-agent.ts`](../../src/agents/recovery-agent.ts) 为准，门禁快照为 [`recovery-system-prompt.txt`](../../test/snapshots/recovery-system-prompt.txt)。System Prompt 组成顺序是角色正文、`# Workspace`、locale 语言块、可见过程规则。首条用户消息是文本简报加 understand，不是 JSON 工作集；`completedFreeformTurns > 0` 且 Session 新建时，简报经 resume 段前置到 restore 或 conclude。机械检查反馈使用 `RECOVERY_TURN_PROMPTS.mechanicalFeedback`。只读 `source/` 与稀疏工作区见 [稀疏 source mount](../decisions/accepted/2026-09-11-recovery-sparse-source-mount.md)。契约、Playbook 版本与 observations `INDEX.md` 见 [文本简报与 Playbook v2](../decisions/accepted/2026-09-15-recovery-text-briefing-and-playbook-v2.md)。

工具注册、路径边界与机械校验由 Host 执行，Recovery 在工作副本内自主调查、清理、恢复和重建。每轮结束前更新 `.reprise/recovery-work/notes.md`；任务所需内容迁到正常路径，封存前删除该目录。Recovery 业务结论为 `ready` 或 `blocked`，并带面向操作者的一句话 `summary`；Host 不另设证据评分，也不改写该 summary。信封字段见 [summary 与 seed 同构](../decisions/accepted/2026-09-11-recovery-envelope-summary.md)。

Controller 的可执行 System Prompt、understand / opening / steering、输出契约与压缩指令以 [`controller-agent.ts`](../../src/agents/controller-agent.ts) 为准，门禁快照为 [`controller-system-prompt.txt`](../../test/snapshots/controller-system-prompt.txt)。understand 写入 `notes/understanding.md`；Host 不读该文件，digest 不收录 `notes/`。opening 的 `promptContent` 含完整 INDEX.md；steering 只发 `Latest turn` 行。`edit`/`write` 可写 `project/` 与 `notes/`。行为规范见 [Controller](./controller.md) 与 [英文提示词与 notes](../decisions/accepted/2026-09-15-controller-english-prompts-and-notes.md)。

Comparison 的可执行 System Prompt、四轮委托、输出契约、JSON-only 补救与 Host 区修复以 [`comparison-agent.ts`](../../src/agents/comparison-agent.ts) 为准，门禁快照为 [`comparison-system-prompt.txt`](../../test/snapshots/comparison-system-prompt.txt)。组成顺序与 Recovery 相同：角色正文、`# Workspace`、locale 语言块、可见过程规则。HTML 规则、区域映射和 `data-claim` 写在 compose 与模板注释，不写进 System Prompt。understand 把任务理解写入 `work/comparison-plan.md`。报告壳文案随 locale，发布合同认 `data-claim`；词表兜底只写入 Host limitations 并仍发布，见 [提示词分层与 data-claim](../decisions/accepted/2026-09-15-comparison-prompt-layers-and-data-claim.md) 与 [发布分级](../decisions/accepted/2026-09-16-comparison-publication-tiers-and-cancel.md)。

修改 prompt 时修改上述代码中的唯一文本源，并同步对应角色规范和 ADR；文档只保留语义约束及短例子，不建立另一份“推荐 prompt”。回归检查应能暴露权限扩大、输入遗漏或输出边界变化；纯字符串相等不能代替行为检查。Controller 模拟用户语义的机械合同 lane 与仓库外真实模型能力 lane 分开报告，见 [协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)；不声称模拟测试证明与真人一致。
