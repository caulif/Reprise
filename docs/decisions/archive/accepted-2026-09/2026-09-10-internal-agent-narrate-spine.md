# 决策：内部 Agent 主列钉短句

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted

## 问题

内部 Recovery / Controller / Comparison 的 `assistant_visible` 被锁在 `[o]`，主列只剩工具账本和 `working`。操作者看不到调查意图。候选 thinking 仍不能进主列。

## 决定

候选 live 仍以[此刻行](./2026-09-10-tui-live-now-row.md)为准。内部 Agent 主列以 `agent.assistant_visible` 的 `payload.text` 为脊（`kind: narrate`）。进行中工具只占一行执行条（`itemId: now:{lane}`）。下一段短句到来时，两次短句之间的成功探路收成 `▸ 阅读证据 · N` 或 `▸ 写入 {叶名}`。`agent.context_compacted` 不进主列。失败行单独露出。

模拟用户另钉 Input 卡（`controller.decision` `type=send` 的 `message`）和候选 `user_view_persisted`。有 Input 卡不再画 `Decision: SEND`。DONE 用人话，不用 `no_further_value` 当主句。对照钉 `headline`，不把 Host 四次委托画成章节。候选 thinking 与产品私有 `message.content` 仍不进主列。

## 备选方案

**继续只把短句放进 `[o]`。** 主列仍是 inspect 账本。

**新增 `recovery.finding` / `comparison.finding`。** 与已有短句和信封重复。

**对照页继续铺控制 Agent 的 Input。** 与「每页重新开画」冲突。

## 影响

`src/tui/timeline.ts`、`agent-activity.ts`、`fold-process.ts`、`scrollback.ts`、`pages/run.ts`、`visible-process.ts`。[此刻行](./2026-09-10-tui-live-now-row.md)对候选 live 仍有效。

## 验证

`test/tui/narrative-canvas.test.ts`：`assistant_visible` 主列 `kind: narrate`。连续成功探路只有一条 live；下一句后出现 `▸` 且无 `compact tail`。send 后有 Input、无 `Decision: SEND`。done 主句不含 `no_further_value`。对照完成含 headline。反向：主列再出现 `compact tail`、`shell_exec shell_exec` 或对照页 Input 卡则红。
