# 重构的规范迁移边界

本文只标识当前实现与已确认目标之间需要同时迁移的归宿，不定义另一套实施顺序。顺序与验收以[总计划](./reprise-architecture-redesign.md)为准，界面以[TUI 目标](./reprise-tui-design.md)为准，进度以[MASTER](../progress/MASTER.md)为准。

## 当前到目标

| 迁移边界 | 当前代码与规范 | 目标及关闭条件 |
|---|---|---|
| Session 与模型输入 | [Pi Host](../../src/infrastructure/pi-agent-host.ts)、[持久化](../architecture/persistence-and-crash-consistency.md) | 唯一 Session 事实源，压缩不丢历史；A1、A2、A6–A8 |
| 恢复与场景 | [环境](../architecture/environment.md)、[恢复接受 ADR](../decisions/accepted/2026-08-31-recovery-auto-accept-validated-preview.md) | 证据不足停止，不强行接受；封存场景重复运行，A5、A10、A17 |
| Controller | [Controller](../architecture/controller.md)、[独立理解 ADR](../decisions/accepted/2026-09-04-controller-understanding-pass.md)、[完成守卫 ADR](../decisions/accepted/2026-09-06-controller-completion-evidence-guard.md) | 每 run 连续 Session，取消独立 Understanding 和强制账本守卫；A3 |
| Comparison | [对照](../architecture/comparison.md)、[双阶段 ADR](../decisions/accepted/2026-09-05-comparison-two-phase-attempts-and-pi-media.md) | 每 attempt 单 Session，独立对照与封存输入；A4、A17 |
| CLI 与取消 | [CLI](../../src/cli/main.ts)、[运行结果](../architecture/run-outcome.md) | 完整与分步执行共用实现，本机跨终端取消；A9、A13–A15 |
| Product Pack | [兼容性](../architecture/product-plugin-compatibility.md)、[注册入口](../../src/products/index.ts) | 显式本地插件，第三测试插件无需改宿主；A16、A18 |
| 平台 | [本机平台](../architecture/cross-platform.md)、[Host ADR](../decisions/accepted/2026-09-05-cross-platform-host-and-agent-tools.md) | Windows PowerShell、macOS/Linux Bash，进程树与终端分别验证；A11 |
| TUI | [当前界面](../product/tui.md)、[活动画布 ADR](../decisions/accepted/2026-09-01-internal-agent-activity-canvas.md) | 单列连续记录、键盘入口、03a 左右项目页；按 TUI 验收，更新帧基线 |

工具数量、提示词全文和公共字段以对应代码定义为准，不再用一份平行 prompt 文档重定义。上述迁移必须保留权限、隔离、秘密保护、模型输入可复原、投递未知不重发及结果与清理分离。

## 关闭规则

本表的每行关闭需要对应实现、正向与失败场景证据，以及当前规范与 ADR 的同批更新；只改措辞不算完成。替代 ADR 指向被取代记录，旧记录移入 superseded 并保留链接。未完成的行不能因删除计划而消失。全部关闭后将本表移出活跃计划，只在进度入口记录完成证据。
