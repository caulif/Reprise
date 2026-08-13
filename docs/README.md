# Reprise 文档

本目录保存项目的产品定义、当前架构、研究依据和历史设计。开始实现前，先阅读产品定义和架构总览；研究与归档文档不覆盖当前架构。

## 推荐阅读顺序

1. [产品定义](./product/overview.md)：项目解决什么问题，以及明确不做什么。
2. [TUI 与最小用户交互规划](./product/tui.md)：首次设置、比较主路径、运行时活动流和结果查看层级。
3. [架构总览](./architecture/overview.md)：当前系统边界、生命周期、端口和事件协议。
4. [三个 Agent 的职责、能力与 System Prompt 对齐稿](./architecture/agent-roles-and-system-prompts.md)：明确 Recovery、Controller、Comparison 的定位、工具、产物、提示词与当前实现偏差。
5. [技术选型与实现基线](./architecture/technology-selection.md)：语言、Pi 复用边界、Runtime 控制、TUI、持久化和首发平台。
6. [持久化与崩溃一致性](./architecture/persistence-and-crash-consistency.md)：唯一事件日志、原子提交、单写者、恢复和保留规则。
7. [Product Pack 兼容性](./architecture/product-plugin-compatibility.md)：会话导入、当前 Runtime 事实与兼容降级。
8. [Controller 设计](./architecture/controller.md)：如何实现同等人类能力输入。
9. [Controller 实验条件](./architecture/controller-experiment-conditions.md)：Controller 模型选择、工具、完整会话、预算和压缩条件。
10. [Environment 设计](./architecture/environment.md)：如何发现、恢复和验证历史任务环境。
11. [CandidateRun 结果与终止协议](./architecture/run-outcome.md)：如何区分任务判断、停止原因、技术故障和清理结果。
12. [Comparison 设计](./architecture/comparison.md)：如何以产品无关方式选择和展示结果证据。
13. [非确定性 Agent 的最小验证边界](./architecture/validation.md)：只验证 schema、能力、生命周期和事实完整性。
14. [分模块开发实现计划](./development-plan.md)：实现顺序、模块边界、验收与阶段闸门。
15. [Codex smoke 闸门记录模板](./codex-smoke-gate.md)：真实运行前准入、事实记录和人工复核清单。
16. [架构全景与实施路线](./project-architecture.html)：当前架构与模块实施路线的可视化入口。
17. [架构研究基础](./research/architecture-foundations.md)：架构理论、项目观察和备选方案。
18. [Controller 研究基础](./research/controller-foundations.md)：Controller 的理论和实证依据。
## 文档权威层级

- `product/` 定义产品目标、用户价值和非目标。
- `architecture/` 是实现应遵守的当前规范；其中 `overview.md` 是跨模块语义的唯一主设计。
- `research/` 解释设计依据，可以提出备选方案，但不能覆盖 `architecture/`。
- `archive/` 仅用于历史追溯，不能作为当前实现依据。

如果专题设计与架构总览冲突，以架构总览为准；如果架构设计偏离产品目标，应先明确修改产品定义或记录新的架构决策，而不是让两份文档长期矛盾。

目录放置、命名、链接和迁移规则见[文档结构与路径约定](./documentation-structure.md)。
