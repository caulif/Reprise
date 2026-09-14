# 决策：指针命中打开产物、视口滚动与查找范围

状态：accepted

目标见[指针、视口与查找](../../plan/reprise-tui-pointer-scroll-find.md)。延续[方案 A 树](./2026-09-10-tui-option-a-tree.md)与[阅读锚点](./2026-09-08-tui-reading-search-terminal.md)。

## 问题

鼠标报告开启时终端不跟 OSC 8。结果页短标签点不动。滚轮只移选中、不改视口偏移。恢复页 `/` 查找没有操作者价值。页脚重复可点短标签。

## 决定

- 鼠标报告保持开启。单击按下由应用命中：运行页切 `▸` / 选中；结果页与历史详情命中短标签则打开同一文件入口（`openReport` / `openTrace` / `openReplica` / 本地路径）。未命中不打开文件。
- 滚轮与 ↑↓ 共用选中移动；选中将离开可见窗口时改 `readingOffset`。列表页 SGR 64/65 移光标。`v` 仍关闭鼠标报告。视口 TUI 先注册的 `handleViewportInput` 不得吃掉 SGR 64/65 与单击按下，否则应用滚动与命中收不到事件；ScrollView 子树已按视口裁切，库内 `scrollBy` 是空操作。
- 恢复与准备检查不进入查找、页脚无 `/`。候选运行与对照过程保留查找。
- 页脚只列点不到的键。结果页离开只留 Esc。键盘 `o` / `t` / `w` / `c` 仍有效，不写在页脚。

## 备选方案

**结果页关掉鼠标报告、交给宿主跟 OSC 8。** 与运行页模型分裂，假终端无法证明宿主行为。

**滚轮只移选中、验收即关闭。** 长记录看起来不像在滚页面。

**恢复页保留 `/`。** 时间线短，查找是死键。

## 影响

`page-input.ts` SGR、`pointer-dispatch.ts`、`scrollback.ts` 视口、`pages/result.ts` 命中、`docs/product/tui.md` 页脚。真终端仍按[平台矩阵](../../plan/2026-09-08-platform-evidence-matrix.md)。

## 验证

`test/tui/page-input.test.ts`：SGR 64/65 为列表 up/down；单击带行列。`test/tui/pointer.test.ts`：视口 `handleViewportInput` 让出滚轮后应用监听器才能 `consume`。`test/tui/widgets.test.ts`：恢复 hints 无 Find；结果 hints 只有 Esc；`keepSelectedVisible` 在选中越出窗口时改 offset；结果 OSC 8 行命中 `open-report`，空白行不命中。反向：视口监听器先 `consume` 滚轮则红；恢复帧再出现 `[/]`，或单击空白打开文件则红。
