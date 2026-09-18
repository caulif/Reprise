# 决策：allowModelText 字段化石，恒允许正文

状态：accepted
日期：2026-09-16

## 问题

`privacy.allowModelText=false` 在 Host 开 Session 时直接 `privacy_blocked`，三个内部 Agent 都传该字段，受限 TaskCase 在 Recovery 第一轮就失败。下游却为同一开关写了 `[REDACTED]` / `unavailable` 正文降级和 TUI `t` 切换。操作者关正文并不能保护凭据（凭据走 `redactModelVisibleText`），只会让内部 Agent 看不见题目。

## 决定

不要运行时开关。内部 Agent 始终可读会话正文。`TaskCase.privacy.allowModelText` **保留 schema 键**，避免旧 case 校验失败；读取与冻结一律视为 / 写为 `true`。旧 case 里的 `false` 自此把正文送给内部模型。不删键，不做磁盘迁移。TUI 去掉切换；Host 不再因该字段阻塞 Session；删除 `[REDACTED]` / `unavailable` 正文降级。`allowBinary`、`redactions` 与凭据 `redactModelVisibleText` 不动。

## 备选方案

**false 时用脱敏正文继续跑。** 仍保留操作者开关和两套降级路径，与「内部 Agent 必须看见题目」冲突。

**删除 schema 键。** 旧 TaskCase 无法通过 `Value.Check`。

**只放开 Host、保留 briefing 降级。** 模型仍读不到 briefing 文件里的正文，等于半开。

## 影响

冻结写入 [`FROZEN_ALLOW_MODEL_TEXT`](../../../src/core/schemas/task-case.ts)。[Host](../../../src/infrastructure/agent/host.ts)、[Controller briefing](../../../src/application/controller-briefing.ts)、[Comparison briefing](../../../src/application/comparison-briefing.ts)、observations 与用户可见表面不再按该字段降级正文。[产品总览](../../product/overview.md) 与 [Controller 实验条件](../../architecture/controller.md#4-实验条件) 改为化石字段说明。不改 Comparison resume，不改凭据红acted。

## 验证

`test/application/allow-model-text-fossil.test.ts`：冻结传入 `false` 仍写 `true`；Host 在 `false` 下仍开 Session。`test/products/observation-files.test.ts`：旧 `false` 仍写出助手正文。`test/candidate/fake-target-runner.test.ts`：`projectTurn({ allowModelText: false })` 仍为 `completed`。`test/core/architecture.test.ts`：Host 不含 `privacy_blocked`；TUI 无 `toggle-model-text`；briefing 无正文 `[REDACTED]`。`npm run check` 必须通过。
