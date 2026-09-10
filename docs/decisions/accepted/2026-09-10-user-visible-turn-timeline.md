# 决策：正式时间线只投影 UserVisibleTurn

状态：accepted

延续 [Runtime 事件与用户可见回合](./2026-09-09-candidate-runtime-events.md) 与 [ProductPack 端口](./2026-09-09-product-pack-ports.md)。目标见 [Application 与候选链](../../plan/application-candidate-agent-refactor.md) 阶段 F/L。

## 问题

Pack `translate` 把产品 payload 写成 `TargetActivity`，Application 再落 `runtime.public_activity`。正式时间线依赖这套词表，Controller 视图与 TUI 仍可能把流式中间内容当成操作员事实。

## 决定

`reprise/pack-api` 的 `PACK_API_MAJOR` 为 3。`UserSurfaceProjection` 只提供 `inspectRunFacts` 与 `projectTurn`。Journal 只接受 `runtime.<CandidateRuntimeEventType>`。正式时间线只投影已校验的 `candidate.user_view_persisted`（`UserVisibleTurn`）以及产品无关的 Harness/Controller 事件。不再写入或读取 `runtime.public_activity`，不导出 `TargetActivity`。

## 备选方案

**保留 translate 仅作直播 overlay。** 正式时间线与直播仍两套事实，计划禁止双轨。

**TUI 解析 `runtime.visible_output` 的产品 payload。** Application 与界面重新出现产品分支。

## 影响

本地插件必须声明 `apiMajor: 3`。`current-user-view.md` 的 Prompt 来自该回合 `UserVisibleTurn.prompt`（由 `runtime.visible_prompt` 进入 Pack 事实）。未公开 reasoning 与原始协议包体仍不进主列。

## 验证

`test/timeline.test.ts` 断言 `runtime.visible_output` 与 `runtime.public_activity` 不进正式时间线，`candidate.user_view_persisted` 显示 Visible response。`test/architecture.test.ts` 禁止 `TargetActivity`、`translate(`、`persistPublicActivities`。`test/pack-api-resolve.test.ts` 断言 `PACK_API_MAJOR === 3`。反向：contract 再导出 `TargetActivity` 或 Application 再写 `persistPublicActivities` 则红。
