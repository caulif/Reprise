# 决策：运行页方案 A 树时间线

状态：accepted

目标见[方案 A](../../plan/reprise-tui-live-expand.md)。延续[阅读锚点](./2026-09-08-tui-reading-search-terminal.md)与[此刻行](./2026-09-10-tui-live-now-row.md)。

## 问题

运行页用满宽声部卡把一条对话切成三段，并提供 `o` 打开 `original` overlay。滚轮 SGR 64/65 不被识别。候选 `tool_finished` 清掉叶名。操作者要学一层调试 dump。

## 决定

- 主列是一条树：短句、`●` 执行、`▸` 折叠、Input 横条、候选可见回复。内部 Agent（恢复 / 模拟用户 / 对照）共用薄荷子弹，候选用桃色。列尾一行活着状态。
- 运行页 `o` 无动作。`▸` 的 Enter / 单击在主列露出叶名。结果页 `o` / `t` / `w` 仍打开报告、记录、副本文件。
- SGR 滚轮 64/65 与 ↑↓ 相同：移动选中；内容超出视口时带动 `readingOffset`。单击只处理按下；拖动与阅读模式 `v` 不把 move 当单击。
- 候选 `runtime.tool_finished` 保留刚结束的动词与叶名，直到下一 `tool_started` 或 `user_view_persisted`。无 `live` 时执行条含与顶栏同源的耗时。

不解析 `message.content`，不改 Pack API major。

## 备选方案

**保留全文 overlay。** 操作者仍要学 dump 入口，主列可以继续堆信封。

**三色内部角色。** 与「内部 vs 候选」分色冲突，图例占顶栏。

**滚轮交给 ScrollView follow。** 运行页 `follow: none` 且开启鼠标报告后，原生缓冲不再滚。

## 影响

`timeline.ts` 投影、`scrollback.ts` 树渲染、`page-input.ts` SGR、`docs/product/tui.md` 运行页键位。真终端滚轮与单击仍按[平台矩阵](../../plan/2026-09-08-platform-evidence-matrix.md)。

## 验证

`test/tui/narrative-canvas.test.ts`：候选 live 叶名在 `tool_finished` 后仍在；无 live 含耗时；人话+JSON 无 `"type":"send"`；`write_denied` 不进标题；未展开无叶名；`visible_output` 不进主列。`test/tui/page-input.test.ts`：SGR 64/65 为 move；单击为 click；运行页 `o` 无动作。反向：`timeline.ts` 出现 `message.content`，或运行帧含 `[o]` / send JSON 墙则红。
