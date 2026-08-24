# Reprise 文档

本目录保存产品定义、当前架构规范、决策记录、未完成计划和设计依据。开始实现前先读产品定义和架构总览；`plan/` 与 `research/` 不覆盖当前规范。

结构、受控边界和命名规则见[文档结构与路径约定](./documentation-structure.md)；写文档时的操作性规则见 [`AGENTS.md`](./AGENTS.md)。

## 协作与治理

- [贡献指南](./CONTRIBUTING.md)：环境、验证命令、真实 smoke opt-in、PR 与 agent 输出。
- [安全政策](./SECURITY.md)：私下漏洞报告；不要用公开 Issue 贴 secret。
- [Changelog](./CHANGELOG.md)、[发布清单](./release-checklist.md)、[事故复盘模板](./postmortem-template.md)。
- 任务 brief：[plan/task-brief-template.md](./plan/task-brief-template.md)。Issue / PR 模板在 `.github/`。

## 推荐阅读顺序

1. [产品定义](./product/overview.md)：项目解决什么问题，以及明确不做什么。
2. [TUI 与最小用户交互规划](./product/tui.md)：首次设置、比较主路径、运行时活动流和结果查看层级。
3. [架构总览](./architecture/overview.md)：当前系统边界、生命周期、端口和事件协议。跨模块语义以此为唯一来源。
4. [三个 Agent 的职责、能力与 System Prompt 对齐稿](./architecture/agent-roles-and-system-prompts.md)：Recovery、Controller、Comparison 的定位、工具、产物与提示词。
5. [技术选型与实现基线](./architecture/technology-selection.md)：语言、Pi 复用边界、Runtime 控制、TUI、持久化和首发平台。
6. [持久化与崩溃一致性](./architecture/persistence-and-crash-consistency.md)：唯一事件日志、原子提交、单写者、恢复和保留规则。
7. [Product Pack 兼容性](./architecture/product-plugin-compatibility.md)：会话导入、当前 Runtime 事实与兼容降级。
8. [Controller 设计](./architecture/controller.md)与[实验条件](./architecture/controller-experiment-conditions.md)：同等人类能力输入、模型选择、工具、预算与压缩。
9. [Environment 设计](./architecture/environment.md)：如何发现、恢复和验证历史任务环境。
10. [CandidateRun 结果与终止协议](./architecture/run-outcome.md)：如何区分任务判断、停止原因、技术故障和清理结果。
11. [Comparison 设计](./architecture/comparison.md)：如何以产品无关方式选择和展示结果证据。
12. [非确定性 Agent 的最小验证边界](./architecture/validation.md)：只验证 schema、能力、生命周期和事实完整性。
13. [分模块开发实现计划](./development-plan.md)：模块 0–8 的实现顺序、边界与验收记录。
14. [Codex smoke 闸门](./codex-smoke-gate.md)：真实计费运行的准入、事实记录与人工复核清单。
15. [工程门禁](./engineering-gates.md)：本地 `check`、CI lane、反向用例和覆盖率棘轮。
16. [稳定进度入口](./progress/MASTER.md)：当前工作进度的固定入口。

## 决策记录

`decisions/` 记录长期约束实现的选择及其被放弃的备选方案。格式与何时必须写见[文档结构与路径约定](./documentation-structure.md#决策记录)。

- [建立决策记录](./decisions/accepted/2026-08-14-establish-decision-records.md)：为什么需要 `decisions/`，以及它取代了什么。
- [文档受控边界](./decisions/accepted/2026-08-14-documentation-version-control-boundary.md)：`docs/` 里什么进 git、什么只留本地。
- [覆盖率阈值只升不降](./decisions/accepted/2026-08-14-coverage-thresholds.md)：总体阈值取实测值向下取整，不留缓冲。
- [记录路径按盘符比较](./decisions/accepted/2026-08-14-host-independent-recorded-paths.md)：Windows 会话路径在 POSIX CI 上不得 `resolve()` 进 `process.cwd()`。
- [TUI 帧基线只在 Windows 比对](./decisions/accepted/2026-08-15-tui-frame-baseline-windows-only.md)：帧是平台相关产物，不在 Ubuntu 上逐字节比对。
- [生成区输出信封字段表](./decisions/accepted/2026-08-15-generated-docs-envelope-fields.md)：`EventEnvelope.type` 是开放字符串，不生成类型目录。
- [门禁必须附反向用例](./decisions/accepted/2026-08-15-gate-reverse-tests.md)：只验证干净树上退出 0 不构成门禁生效的证据。
- [报告 Host 壳跟随任务语言](./decisions/accepted/2026-08-14-report-host-chrome-follows-task-language.md)：`report.html` 的壳文案跟随 `initialInput`，不跟 TUI `/lang`。
- [报告第一屏是判断正文](./decisions/accepted/2026-08-14-report-first-screen-is-narrative.md)：不做对照条；限制只留会改变读法的句子。
- [`superseded/`](./decisions/superseded/)：被后续决策取代的记录，仅供追溯，不能作为当前依据。

## 未完成的工作

`plan/` 只保留尚未做完的工作；做完或被取代后按迁移规则移出。

- [当前实现差距与修正计划](./plan/current-implementation-gap-and-correction-plan.md)：canonical 设计与代码的逐项偏差及迁移路线。
- [第六轮优化分析](./plan/optimization-round-6.md)：仍未闭合的 P2/P3 条目与产品承诺缺口。
- [Agent System Prompt 重设计](./plan/agent-system-prompt-redesign.md)：Controller 与 Comparison 提示词的重设计提案。
- [Claude Code Pack 实施](./plan/claude-code-pack-implementation.md)与[第二、第三 Product Pack 全景](./plan/second-product-packs-claude-code-dsh.md)。
- [Canonical Agent Host 重建](./plan/canonical-agent-host-reconstruction.md)。
- [借鉴 Grok Build 的 TUI 重构](./plan/grok-style-tui-redesign.md)与[每面设计稿](./plan/grok-style-tui-mockups.html)。
- [比较报告三方面优化](./plan/comparison-report-optimization.md)：候选执行条件、Comparison 分析与正文、HTML 渲染与配色。
- [以用户为中心的端到端优化](./plan/user-centered-end-to-end-optimization.md)。
- [下一阶段开发计划](./plan/further-development-plan.md)：实时时间线、CLI 入口和新验收任务。
- [TUI 之后的产品路线图](./plan/reprise-post-tui-roadmap.md)。

## 设计依据

- [架构研究基础](./research/architecture-foundations.md)与[Controller 研究基础](./research/controller-foundations.md)：解释为什么这样设计，可以提出备选方案，但不覆盖 `architecture/`。

## 不在版本控制内的材料

一次性审查、走查记录、被取代的计划留在本地 `docs/.local/`；TUI 走查产物、截图和验收证据留在 `docs/tui-*/`、`docs/evidence/`。它们不能作为当前实现依据，受控文档也不链接它们。唯一受控的产物是 [`tui-audit/frames/`](./tui-audit/frames/)——CI 逐字节比对的 TUI 快照基线。

## 文档权威层级

- `product/` 定义产品目标、用户价值和非目标。
- `architecture/` 是实现应遵守的当前规范；其中 `overview.md` 是跨模块语义的唯一主设计。
- `decisions/accepted/` 拥有某个长期选择的理由与被放弃的方案；它不重新定义 `architecture/` 的类型。
- `development-plan.md` 记录模块 0–8 的顺序与验收；`progress/MASTER.md` 是稳定的当前进度入口。
- `plan/` 是尚未完成的工作，不能覆盖当前规范。
- `research/` 解释设计依据，不能覆盖 `architecture/`。
- 各层 `AGENTS.md` 只索引规范并给出指令，不定义规范。

如果专题设计与架构总览冲突，以架构总览为准；如果架构设计偏离产品目标，应先修改产品定义或写一份决策记录，而不是让两份文档长期矛盾。
