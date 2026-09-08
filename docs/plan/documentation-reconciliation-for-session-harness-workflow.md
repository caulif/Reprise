# 重构的规范迁移边界

本文只标识当前实现与已确认目标之间需要同时迁移的归宿，不定义另一套实施顺序。顺序与验收以[总计划](./reprise-architecture-redesign.md)为准，界面以[TUI 目标](./reprise-tui-design.md)为准，进度以[MASTER](../progress/MASTER.md)为准。

## 当前到目标

| 迁移边界 | 当前代码与规范 | 目标及关闭条件 |
|---|---|---|
| Session 与模型输入 | [Pi Host](../../src/infrastructure/pi-agent-host.ts)、[持久化](../architecture/persistence-and-crash-consistency.md)、[事实源 ADR](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)、[模型输入 ADR](../decisions/accepted/2026-09-08-model-input-reconstruction.md)、[历史只读 ADR](../decisions/accepted/2026-09-08-history-readonly-compat.md) | A1、A2、A6–A8 以规划编号关闭；机械路径见对应 ADR |
| 恢复与场景 | [环境](../architecture/environment.md)、[Recovery 连续 Session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)、[场景封存](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md) | A5、A10、A17；真实历史样本评估仍见恢复评估计划 |
| Controller | [Controller](../architecture/controller.md)、[opening 同 Session ADR](../decisions/accepted/2026-09-08-controller-opening-single-session.md)、[协作协议](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md) | 无独立 Understanding、无账本守卫；五族样例人工核对见 MASTER；真实模型 lane 须 `REPRISE_REAL_MODEL=1`，MiniMax 代表样例未全部匹配 |
| Comparison | [对照](../architecture/comparison.md)、[单 Session ADR](../decisions/accepted/2026-09-08-comparison-single-session.md) | A4、A17 |
| CLI 与取消 | [CLI](../../src/cli/main.ts)、[共用操作 ADR](../decisions/accepted/2026-09-08-shared-experiment-operations.md)、[跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md) | A9、A13–A15 |
| Product Pack | [兼容性](../architecture/product-plugin-compatibility.md)、[注册入口](../../src/products/index.ts)、[第三 Pack](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md) | A16 模拟第三 Pack 与 A18；真实 Runtime smoke 仍 opt-in |
| 平台 | [本机平台](../architecture/cross-platform.md)、[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)、[平台证据矩阵](./2026-09-08-platform-evidence-matrix.md) | A11：CI 三 OS 模拟 shell/路径/进程；**TUI 真终端 IME 不在 A11** |
| TUI | [当前界面](../product/tui.md)、[公开时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md)、[阅读与终端](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)、[界面重构](./reprise-tui-surface-refactor.md) | 页图以 `product/tui.md` 为准。真终端见[平台矩阵](./2026-09-08-platform-evidence-matrix.md) |

工具数量、提示词全文和公共字段以对应代码定义为准，不再用一份平行 prompt 文档重定义。上述迁移必须保留权限、隔离、秘密保护、模型输入可复原、投递未知不重发及结果与清理分离。

## 关闭规则

本表的每行关闭需要对应实现、正向与失败场景证据，以及当前规范与 ADR 的同批更新；只改措辞不算完成。替代 ADR 指向被取代记录，旧记录移入 superseded 并保留链接。未完成的行不能因删除计划而消失。全部关闭后将本表移出活跃计划，只在进度入口记录完成证据。
