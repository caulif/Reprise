# Session / Harness / Workflow 重构的文档处置

状态：本轮文档迁移的执行清单。

## 唯一来源

[架构重构规划](./reprise-architecture-redesign.md)是尚未实施目标的唯一文字来源；[TUI 设计](./reprise-tui-design.md)是目标交互来源；[决策提案](../decisions/proposed/2026-09-07-reprise-session-harness-workflow.md)记录已确认但未生效的长期选择。当前代码仍由 `product/`、`architecture/` 和 `decisions/accepted/` 描述。

## 处置

| 类别 | 处理 |
| --- | --- |
| `plan/` 中的旧 Host、Recovery、Controller、Comparison、会话发现和 TUI 专题计划 | 已被总计划覆盖，迁入 `docs/.local/plan-pre-session-harness/` |
| `research/` 中的中间架构、工具面和理论稿 | 迁入 `docs/.local/research-pre-session-harness/`；不作为规范入口 |
| 单次运行分析、真实使用记录和旧进度 | 迁入 `docs/.local/`；不保留受控链接 |
| `product/`、`architecture/`、安全/门禁、`tui-audit/frames/` | 保留；在对应代码迁移批次更新真实行为 |
| `decisions/accepted/` | 保留当前实现依据；代码迁移完成且有替代 ADR 时才移入 `superseded/` |

直接冲突且必须由替代 ADR 处理的旧选择包括：Pi Host 不拥有 Session 事实源、Controller 独立 Understanding、Comparison Planner/Reporter 双 session、统一八/七工具作为内核，以及 Windows-only 产品范围。替代 ADR 必须保留安全、事件复原、隔离和取消不变量。

## 收口标准

README 与进度入口只链接当前规范、目标总计划、TUI 设计、决策提案和 task brief。受控文档不得链接 `docs/.local/`。移走材料前先消除入站链接；文档门禁通过后，旧材料才算退出活跃文档树。
