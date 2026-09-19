# Reprise 文档

Reprise 从历史会话恢复任务起点，让候选 Agent 在隔离副本中重新执行，再按需比较交付结果。

| 你要做什么 | 阅读入口 |
|---|---|
| 安装、配置、选择会话并运行 | [使用指南](./usage.md)；首次构建见[根 README](../README.md) |
| 理解模块和主调用链 | [架构总览](./architecture/overview.md) |
| 修改 Controller 或候选运行 | [执行流程](./architecture/execution.md) |
| 修改恢复与工作区隔离 | [Recovery](./architecture/recovery.md) |
| 修改日志、模型输入或对照报告 | [证据与 Comparison](./architecture/evidence-and-comparison.md) |
| 开发、测试或准备发布 | [开发与验证](./development.md) |
| 判断哪些能力仍未完成或未验证 | [路线图](./roadmap.md) |

当前行为以以上文档和对应源码为依据；设计理由按需检索 [ADR](./decisions/README.md)。历史决策和 plan/archive 不是现行能力清单。本机 `.local` 与生成帧是证据或构建材料，不是入门必读。

贡献、维护职责和文档更新约定见[贡献指南](./CONTRIBUTING.md)。另有[安全政策](./SECURITY.md)、[行为准则](./CODE_OF_CONDUCT.md)和[变更记录](./CHANGELOG.md)。
