# 决策：Controller 权限快照分层、按 settlement 取视图、确认提示进 view

状态：accepted
日期：2026-09-09

## 问题

`permissions.txt` 把隐私策略写成候选写入禁令，历史 full access 也会显示 `writes=denied`。`view.txt` 用整次运行最后一条助手文本，失败或无文本的新一轮会把上一轮回复当成当前回复。用户可见确认若只在公开活动事件里、不在最终回复中，快照会写成 `prompt=(none)`。

## 决定

- `permissions.txt` 分两层：Controller 工具始终 `controller.writes=denied` 且 `project/` 只读；候选运行权限来自 TaskCase 已解析的历史设置（`taskContext` 与历史事件中的 sandbox / permissionMode / approvalPolicy），缺失时标 `unconfirmed` 并注明 Host 安全上限，不把候选写成一律禁止写入。
- 当前 `view.txt` 的可见助手文本只来自最近一次 `runtime.turn_settled` 对应的事件区间，且是该区间内全部公开 `text` 的拼接；整次运行的 `finalMessage` 仍供 Comparison 摘要使用。区间内拼接见 [可见表面与 Git sink](./2026-09-10-visible-surface-and-git-sink.md)。
- `view.txt` 的 Visible prompt 来自该区间投影出的 `UserVisibleTurn.prompt`（Pack 从 `runtime.visible_prompt` 收集）。

## 备选方案

**继续用隐私字段冒充候选权限。** 无法区分只读观察工具与候选运行时权限。

**继续用全 run 最后一条消息。** 失败回合会误导 Controller 结束或继续。

## 影响

[Controller 设计](../../architecture/controller.md)、[实验条件](../../architecture/controller-experiment-conditions.md)。

## 验证

- `test/controller-briefing.test.ts`：Controller 只读与历史 full access 的候选 `writes=allowed`；waiting 视图含确认提示且无旧回复。
- `test/experiment-inspection.test.ts`：后一轮失败不沿用上一轮 `turnVisibleText`；prompt 来自 `runtime.visible_prompt`。
- `npm run check`。
