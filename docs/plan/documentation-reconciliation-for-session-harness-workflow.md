# 重构的规范迁移边界

未关闭原因：真实运行证据尚未闭环，Recovery 空 staging 与基线复用条件修补仍有目标差异。本文只连接当前规范与开放目标，不维护已关闭施工清单。

## 当前到目标

| 边界 | 当前规范 | 剩余验收归宿 |
|---|---|---|
| 模型输入、Controller、Runtime 与平台 | [持久化](../architecture/persistence-and-crash-consistency.md)、[Controller](../architecture/controller.md)、[本机平台](../architecture/cross-platform.md) | [证据矩阵](./2026-09-08-platform-evidence-matrix.md)：真实 provider 对拍、Controller 真实模型 lane、Runtime smoke、真终端 |
| Recovery staging | [环境](../architecture/environment.md)、[稀疏 source mount](../decisions/accepted/2026-09-11-recovery-sparse-source-mount.md) | [最小 Host](./recovery-agent-minimum-host.md)：默认空 staging，不能把超预算 sparse 当作全面完成 |
| Recovery 基线复用 | [场景封存](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md) | [起点恢复目标](./recovery-initial-environment.md)：复用前运行条件检查、缺失时修补且不污染 baseline |

目标验收语义见[架构目标](./reprise-architecture-redesign.md)与[TUI 目标](./reprise-tui-design.md)，当前批次与完成证据见[MASTER](../progress/MASTER.md)。已生效规则以当前规范和对应 accepted ADR 为准，目标不得作为当前操作能力。

## 关闭规则

关闭需要对应实现、正向与失败场景证据，以及受影响规范与 ADR 的同步更新。文档校验、离线模拟或计划归档不能替代真实运行证据。全部差异关闭后移出活跃计划；不因归档而丢弃未完成验收。
