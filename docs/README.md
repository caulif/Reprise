# Reprise 文档

当前事实在 product/ 与 architecture/，未关闭目标在 plan/，选择理由在 decisions/。先确定任务是当前修复还是目标迁移；文件日期不决定权威。

## 按模块阅读

| 模块 | 当前规范 | 工程或专题入口 |
|---|---|---|
| 产品与安全 | [产品定义](./product/overview.md) | [TUI 操作](./product/tui.md) |
| 跨模块生命周期 | [架构总览](./architecture/overview.md) | [角色与 prompt](./architecture/agent-roles-and-system-prompts.md) |
| 持久化与 CandidateRun | [持久化](./architecture/persistence-and-crash-consistency.md) | [结果与终止](./architecture/run-outcome.md) |
| Recovery / 环境 | [环境](./architecture/environment.md) | [验证](./architecture/validation.md) |
| Controller | [Controller](./architecture/controller.md) | [实验条件](./architecture/controller-experiment-conditions.md) |
| Comparison | [对照](./architecture/comparison.md) | — |
| Product Pack / 平台 | [Pack 契约](./architecture/product-plugin-compatibility.md) | [本机平台](./architecture/cross-platform.md) |
| 日常开发 | [开发环境与验证](./development.md) | [按改动跑门禁](./cookbook/verify-change.md) |
| 贡献与维护 | [贡献指南](./CONTRIBUTING.md) | [治理](./GOVERNANCE.md)、[门禁契约](./engineering-gates.md) |
| 文档维护 | [文档结构](./documentation-structure.md) | [文档指令](./AGENTS.md)、[写 ADR](./cookbook/add-adr.md) |

## 开放目标与证据

[MASTER](./progress/MASTER.md)集中列出开放目标与短证据；[平台矩阵](./plan/2026-09-08-platform-evidence-matrix.md)区分 CI、真终端和授权 Runtime 验证。目标计划不是已交付能力，文档清理不能关闭尚缺的真人或付费验证。

决策触发、生命周期与搜索见 [decisions/README](./decisions/README.md)，这里不维护 ADR 标题索引。公开检出仅依赖受控文档，不依赖本机草图或归档。
