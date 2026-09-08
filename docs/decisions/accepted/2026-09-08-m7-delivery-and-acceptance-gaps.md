# 决策：M7 收口后的现行路径与未关闭验收

状态：accepted

目标批次见 [M7](../../plan/reprise-refactoring-execution.md#9-m7旧实现删除规范生效与交付)。

## 问题

迁移批次结束后，产品名硬编码、账本守卫停止码和“全面验收已通过”容易混在一起。公开文档需要写清现行入口，以及人工语义与真终端证据仍未关闭。

## 决定

- 无名 `sessionsRoot` 绑定显式 `pack`，否则绑定当前列表中第一个具备 import 能力的 Pack；`sessionsRoots` 可覆盖。不按 `productId === "codex"` 猜测。
- Harness 停止码不含 `stalled.controller_completion_guard`。账本守卫条款仍冻结在 [PPT 分页决策](./2026-09-06-ppt-flow-convergence-and-observation-bounds.md) 被取代段落，不作为新写路径。
- 目标 ADR 已迁入 accepted，未关闭项写在该记录与[平台证据矩阵](../../plan/2026-09-08-platform-evidence-matrix.md)：TUI macOS/Linux 真终端与 opt-in Runtime smoke 未关闭；Controller 真实模型 lane 须 `REPRISE_REAL_MODEL=1`。MiniMax-M3 在 INDEX+只读工具代表样例上 1/5 匹配；其余为 intent 不符、schema 联合校验失败或 `agent_failure`，不能写成已生效。A11 以 CI 三 OS 模拟为准，不与 TUI IME 混写。
- `npm run evaluate:controller` 要求 `REPRISE_REAL_MODEL=1`，不进入 `npm run check`。
- 实施计划 M1–M7 作为已关闭批次日志保留在 `plan/`，供 ADR 锚点；活跃导航指向未关闭验收，不指向下一批代码迁移。

## 备选方案

**按 Codex 身份继续映射无名 sessionsRoot。** 应用层产品名分支，与 Pack 能力模型冲突。

**把未验证的真终端写成已支持。** 会把 macOS/Linux IME 与未授权 Runtime smoke 冒充现行能力。accepted 记录必须保留 unverified 行。

## 影响

TUI 测试仍可注入 session 适配器。CLI 生产路径继续 `sessionsRoots`。公开检出以 Markdown 与 `reprise/pack-api` 为准。

## 验证

`test/product-first-intake.test.ts` 覆盖多 Pack 无名根不串产品、显式 `pack` 与单 Pack 绑定。`test/architecture.test.ts` 禁止 `productId === "codex"` 与 `controller_completion_guard`。`test/controller-capability-evaluation.test.ts` 禁止门禁包含 `evaluate:controller`。`npm run check` 必须通过。反向：恢复 Codex 身份映射、账本停止码，或把能力 lane 编入 `run-gates.mjs` 则红。
