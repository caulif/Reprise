# 内部 Agent Trace：短句为脊、执行条一行

当前产品规范见[产品 TUI](../product/tui.md)。候选 live 仍以[此刻行](../decisions/accepted/2026-09-10-tui-live-now-row.md)为准。本机草图：`docs/research/reprise-tui-operator-canvas.html` 的「恢复 · 目标逐步」「模拟用户 · 目标逐步」「对照 · 目标逐步」。HTML 不受控，不拥有验收。

页面衔接：恢复结束后进入候选产品，只保留选产品、选模型两页；选完模型进入模拟用户运行，不要第三页确认、也不要启动过渡帧。选候选时背景仍是恢复终态。模拟用户页**不投影恢复色块**，主列从控制 Agent 重新开始。结果页按 `c` 进入对照；对照页**不投影控制 Agent 的 Input 与候选回复**，主列从对照 Agent 重新开始。声部标题写「控制Agent」「对照Agent」；事件 `role` / `itemId` 仍是 `controller` / `comparison` 与 `now:*`。

三个内部 Agent **同构同色**的是探路：短句钉住、执行条一行、下一段话到来时 flush 成 `▸`、同一条记录往下长、中间零句不清屏。子弹色与模拟用户、对照共用内部色，见[方案 A](./reprise-tui-live-expand.md)。模拟用户**多两张牌**：Input 横条和候选可见回复（候选用另一色）。对照**没有**这两张牌，结束钉 `headline` 与报告，不把 Host 四次委托画成章节。

## 共用画面

树上探路只交替两类东西：

1. **短句**：`agent.assistant_visible` 的 `payload.text`。钉住，不被工具顶掉。
2. **执行条**：左边动态点，右边永远一行（动词 + 叶名），`itemId: now:recovery` 或 `now:controller` 原地替换。

下一次短句到来时，两次短句之间的工具收成一行 `▸ 阅读证据 · N` 或 `▸ 写入 {叶名}`。`agent.context_compacted` 不进主列。失败行不得并进摘要。

中间没有新短句时，已钉住的话和 `▸` 摘要留在上面，只有底下一行执行条继续换。Host 不编旁白，也不清空前面的 trace。执行条闪点、`▸` 展开叶名、Enter/单击切折叠见[方案 A](./reprise-tui-live-expand.md)。

## 恢复

结束钉三层，都来自已有字段：

- 用户终态一词：已恢复 / 部分恢复 / 无法恢复（`userRecoveryStatus` / `recovery-diagnosis.json` 的 `finalStatus`）
- `recovery.md` 首段摘录（`providerPreview.reportText`）；打开全文走结果页产物，不设运行页 overlay（见[方案 A](./reprise-tui-live-expand.md)）
- 若有：信封 `value.unresolved[]` 各一行

| 画面 | 事件 / 字段 |
|---|---|
| 短句 | `agent.assistant_visible`（`role` 缺省 recovery；JSON 信封与 thinking 已在 `visibleAssistantText` 丢掉；空则不发） |
| 执行条 | `agent.tool_called` / `tool_completed` / `tool_failed`：`tool`、`params.path` 或命令叶名 |
| 压缩（藏） | `agent.context_compacted` |
| 调用结束清此刻行 | `agent.invocation_completed` 等已有 `clearNow` |
| 用户终态 | `userRecoveryStatus()`，不要用 `recovery.completed` 外层 `status=completed` |
| 摘录 | `providerPreview.reportText`；缺口 `value.unresolved` 或 `baseline.recovery.unresolved` |

禁止新增 `recovery.finding`。禁止从独白里「翻译」Git 状态。

## 模拟用户

主列从空白开始，不接恢复摘要。探路规则与恢复相同，脊柱额外两段：

1. **Input 卡**：`controller.decision` 且 `value.type=send` 的 `value.message`。标题写探测 / 后续等意图（`value.intent` 有则用人话），附投递状态与 turn。有卡就不再画 `Decision: SEND` 重复行。
2. **候选可见回复**：`candidate.user_view_persisted` 的助手正文。未结算时候选色块只留一行 `working (Ns)` 或 Pack 公开 `live`；结算后替换执行条，不另起 UUID 行。

1–2 轮默认把 Input 卡和可见回复留在主列，不折成 `▸ 第 N 轮`。轮次切分按决策的 send / done，不按标题是否以 `Decision:` 开头。折的是两次投递之间的探路工具，不是把 Input 折进探路摘要。

结束钉在同一条记录末尾：

- 主句用人话：`DONE · 没有继续的价值` 一类，由 `value.type=done` 加 `value.reason` 映射，**不要把** `no_further_value` **当主句**
- 其下摘录 `value.rationale` 首段；不设运行页 overlay（见[方案 A](./reprise-tui-live-expand.md)）
- 投递拒绝、失败各占一行，不得并进 `▸`

藏：`compact tail`、会话 UUID、黄字「仍在等待本轮结束」、argv、每条 inspect、`shell_exec shell_exec`、标题再叠 `· working`、恢复色块。控制 Agent 短句不是第二张 Input 卡。

| 画面 | 事件 / 字段 |
|---|---|
| 短句 | `agent.assistant_visible`（`role=controller`） |
| 执行条 | 同上工具事件，`itemId: now:controller` |
| Input 卡 | `controller.decision` `value.type=send`：`message`、`intent`；投递态来自已有 input / delivery 投影 |
| 候选回复 | `candidate.user_view_persisted` |
| 结束 | `controller.decision` `value.type=done`：`reason` 映射人话，`rationale` 作摘录 |
| 压缩（藏） | `agent.context_compacted` |

不改 `ControllerDecision` schema，不解析产品私有 `message.content`。

## 对照

主列从空白开始，不接控制 Agent 记录。探路规则与恢复相同。没有 Input 卡，没有候选回复。

Host 连续四次委托（understand / investigate / compose / review）只驱动同一 Session，**不**在主列画「第 N 委托」。阶段靠短句自己说。

结束钉三层，都来自已有字段：

- 终态一词：对照完成 / 证据不足 / 对照失败（`comparison.completed` 的 `status`，对应信封 `completed` / `insufficient_evidence` / 失败 invocation）
- `headline` 一句（信封可选字段）；没有 headline 时不要用 `limitationCodes` 或 `report.html` 路径当主句
- 短标签打开 `reportPath`（结果页）；不设运行页 overlay

`limitationCodes` 默认不铺主列。禁止新增 `comparison.finding`。禁止把对照 `headline` 写成模拟用户的任务判断。

| 画面 | 事件 / 字段 |
|---|---|
| 短句 | `agent.assistant_visible`（`role=comparison`） |
| 执行条 | 同上工具事件，`itemId: now:comparison` |
| 压缩（藏） | `agent.context_compacted` |
| 调用结束清此刻行 | `agent.invocation_completed` 等已有 `clearNow` |
| 终态 / headline | `comparison.completed` 的 invocation `value.status`、`value.headline`、`value.reportPath` |

藏：`compact tail`、argv、每条 inspect、`shell_exec shell_exec`、顶栏「候选运行中 · 第 N 轮」、JSON 信封、控制 Agent 色块。

## 代码改哪里

**投影（主工作）**

- [`src/tui/timeline.ts`](../../src/tui/timeline.ts) `projectInternalNow`：`assistant_visible` 改为 `kind: 'narrate'` 主列正文，不要再写成 `{声部} · working` 并把原文只塞 `original`。`controllerEntries`：send 只出 Input 卡；done 出人话主句 + rationale 摘录，不要 `Decision: SEND` / `Decision: DONE · no_further_value` 当默认标题。`projectComparisonCompleted`：主列用人话终态 + `headline`，不要 `Comparison completed` 拼 `report.html · limitationCodes`。
- [`src/tui/agent-activity.ts`](../../src/tui/agent-activity.ts)：进行中工具继续 `patch: replace` + 对应 `now:{lane}`；`tool_completed` 成功探路默认不追加历史行（或只累加待 flush 计数）。修 `shell_exec shell_exec` 双重动词。声部前缀落地为恢复活动 / 控制Agent / 对照Agent。
- [`src/tui/fold-process.ts`](../../src/tui/fold-process.ts)：以 `narrate` 为边界 flush 工具组；组标题 `阅读证据 · N` / `写入 {叶名}`。轮次按 send / done 切，不按 `Decision:` 字符串。当前轮与至多一轮历史默认展开 Input 与可见回复。对照没有轮次折叠。
- [`src/tui/scrollback.ts`](../../src/tui/scrollback.ts)：`kind: narrate` 用正文色；live 行带点；`compact` 过滤掉。
- [`src/tui/pages/run.ts`](../../src/tui/pages/run.ts)：标题不要叠 `· working`；对照阶段用「正在写对照报告」，不要「候选运行中 · 第 N 轮」。恢复终态用诊断三词；控制 Agent 结束不用内部码当主句。进入模拟用户不要带恢复色块；进入对照不要带 Input / 候选回复。候选选择停在模型页，Enter 开跑。
- [`src/tui/view-projection.ts`](../../src/tui/view-projection.ts)：恢复结束段接上已有的 `reportText` / `unresolved`。对照结束接上 `headline` / `reportPath`。结果框在 skipped 写未运行；完成后改用人话 + headline，不把 headline 当任务判断。

**Prompt（小改，不改 schema）**

- [`src/agents/visible-process.ts`](../../src/agents/visible-process.ts)、[`src/agents/recovery-agent.ts`](../../src/agents/recovery-agent.ts)、[`src/agents/controller-agent.ts`](../../src/agents/controller-agent.ts)、[`src/agents/comparison-agent.ts`](../../src/agents/comparison-agent.ts)：第一批工具前、以及交信封 / 交决策前各至少一句人话；中间仍允许零句。恢复与对照最后一条仍是 JSON 信封。

**决策记录（同批）**

[此刻行](../decisions/accepted/2026-09-10-tui-live-now-row.md) 把内部 `assistant_visible` 锁在 `[o]`。[可见短句](../decisions/accepted/2026-09-02-visible-process-and-optional-comparison.md) 规定短句为脊。落地时新增一条 ADR：内部 Recovery、Controller、Comparison 主列钉短句；候选 thinking 仍不进主列。旧此刻行记录改为「对候选 live 仍有效；对内部短句以新记录为准」，移入 superseded 或缩小范围，不要改写历史正文。

不改 Pack、不改 `RecoveryResult` / `ControllerDecision` / `ComparisonResult` 信封、不改 `instrumentTools` 的 payload 形状。

## 测试

改 [`test/tui/narrative-canvas.test.ts`](../../test/tui/narrative-canvas.test.ts)：`assistant_visible`「先看隔离副本是不是仓库。」必须出现在主列 `kind: narrate`，不得再断言标题为 `working`。

补恢复：连续 `tool_completed` 只有一条 live；下一次 `assistant_visible` 后出现 `▸` 摘要且不含 `compact tail`；`recovery.completed` 外层 `completed` 显示成已恢复/部分/无法（由诊断投影，测试里注入 `finalStatus` 或等价 view）。反向：主列再出现 `compact tail` 或 `shell_exec shell_exec` 则红。

补模拟用户：send 后主列有 Input 正文、无 `Decision: SEND`；未结算时候选色块有 `working`；`user_view_persisted` 后可见回复替换该行；done 主句不含 `no_further_value`、含 rationale 摘录。反向：主列再出现会话 UUID、`compact tail`、黄字等待或恢复色块则红。改 [`test/tui/timeline.test.ts`](../../test/tui/timeline.test.ts) 里对 `Decision: SEND` 标题的断言。

补对照：`assistant_visible` 进主列 `narrate`；连续工具只有一条 live；结束后主句为对照完成/证据不足/失败且含 `headline`（有则）；无 `compact tail`、无 `inspect artifact ×N`、无「第 N 轮」。反向：对照页再出现 Input 卡或 `Decision: SEND` 则红。

`npm run build` 后再跑相关 `node --test`。改 TUI 源码后走 `npm run check`。只改本文与草图时 `npm run verify:docs`。

## 验收

假终端默认帧：有短句则可见；执行条一行；flush 后旧工具不是文件名列表；无 argv、无 compact。中间零句时上面的短句与摘要仍在。恢复结束后有三词 + 摘录（有 `reportText` 时）。候选产品目标只有选产品、选模型两帧。模拟用户默认帧无恢复色块；有 Input 卡与候选回复（有对应事件时），无 `Decision: SEND` 重复、无 UUID、无黄字等待；1–2 轮 Input 仍展开。对照默认帧无控制 Agent 色块、无候选第 N 轮；结束有人话终态 + headline（有则）。声部标题为控制Agent / 对照Agent。真终端仍按[平台矩阵](./2026-09-08-platform-evidence-matrix.md)，HTML 不算关闭。
