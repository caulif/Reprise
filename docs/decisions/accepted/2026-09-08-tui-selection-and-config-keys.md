# 决策：TUI 选择与配置键盘流程

状态：accepted

目标批次见 [M5.3](../../plan/reprise-refactoring-execution.md#m53-tui-选择与配置流程)。

## 问题

首页单字母捷径、配置页 `s`/`t`、会话列表 `f`/`m`/`r` 会截获 IME 与筛选输入。空匹配仍可能被 Enter 吞掉。切层会丢掉筛选。未保存配置草稿可被 Esc 直接丢弃。

## 决定

- 首页只接收斜杠命令：`/` 建议、↑↓ 选择、Tab 补全、Enter 执行。Continue 区列出 `/run` `/intake` `/config`，不绑定单字母。
- 配置：Enter 应用字段、Esc 撤销字段；Ctrl+S 校验保存、Ctrl+T 测试连接。脏草稿离开先确认：Ctrl+S 保存、Enter 放弃、Esc 留下。内部模型与候选 Runtime 模型分栏标注。
- 来源列表：可打印输入进入筛选。Ctrl+F 切换可用会话过滤，Ctrl+N 续页，Ctrl+R 刷新。Ctrl+M 与 Enter 同码，不用。
- 产品→项目→会话保留该层筛选与选中身份。空匹配给出说明且不进入下一层。无历史、无匹配、无权限、读取失败分文案。摘要截断仍可进入核对页。

## 备选方案

**保留字母捷径、仅在 searching 时让出按键。** 未按 `/` 时拼音与筛选仍被截获。

**用 Ctrl+M 续页。** 终端里 Ctrl+M 就是 Enter。

## 影响

真实终端 IME/滚轮证据仍属 M6。时间线内 `/` 搜索属 M5.5。

## 验证

`test/page-input.test.ts`：首页 `r` 进入 composer；列表字母筛选；Ctrl 和弦分页。`test/config-editor.test.ts`：`s` 不保存，Ctrl+S 保存，脏草稿 Esc 确认。`test/intake-ui.test.ts`：空列表四分文案。反向：空 composer 按 `r` 仍直接开跑，或空匹配 Enter 进入下一层，则红。
