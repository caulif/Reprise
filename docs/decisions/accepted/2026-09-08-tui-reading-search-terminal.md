# 决策：阅读锚点、搜索与终端恢复

状态：accepted

目标批次见 [M5.5](../../plan/reprise-refactoring-execution.md#m55-阅读搜索与终端交互)。

## 问题

时间线用可见下标当阅读位置，追加和折叠会抢走正在看的条目。画布查找扫 `original` 长输出。没有暂停重绘的阅读模式。`fileLink` 无条件发 OSC 8。崩溃路径不一定离开 alt screen。

## 决定

- 阅读锚点是 `itemId` 或 `sequence`。未跟随追加后按身份恢复选中；跟随仅当锚点仍是可见列表最后一条。Home 到最早可见条，End/`l` 跟随最新。
- `/` 在运行页查找可见标题与短文案（含折叠组内标题）。不匹配 `original`。Enter / Shift+Enter 在命中间移动并展开覆盖该条的折叠组。首页 `/` 仍是命令入口。
- `v` 在非查找、非编辑时进入阅读模式：写入关闭鼠标报告序列，暂停跟随与 `requestRender`；`onEvent` 仍追加。退出后按可见条数提示新活动。查找中的 `v` 写入查询。
- `fileLink` 只链接 `isFsAbsolute` 路径；`getCapabilities().hyperlinks` 为真才 OSC 8，否则显示完整路径；标签与 URI 去掉终端控制序列。
- 真实 `ProcessTerminal` 启动时登记 `exit` / `uncaughtException` / `unhandledRejection`，幂等 `tui.stop()`。假 TUI 无 `terminal.write` 不登记。

## 备选方案

**继续用可见下标。** 折叠和追加必然跳选中。

**查找扫 `original`。** 长工具输出淹没标题命中。

**阅读模式只停跟随、仍重绘。** 无法稳定原生选区。

## 影响

真实滚轮、IME、修饰点击与缩放仍属 M6。HTML 原型不是终端证据。

## 验证

`test/timeline-read.test.ts`：身份锚点、不匹配 original、折叠覆盖、OSC 8 开关、异常路径 `stop` 一次。`test/page-input.test.ts`：Enter/Shift+Enter/`v` 查找冲突。反向：`matchesCanvasQuery` 再命中 `original` 独有字符串则红。
