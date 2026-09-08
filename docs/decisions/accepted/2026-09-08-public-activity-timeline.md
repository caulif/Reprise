# 决策：公开活动持久化与单列时间线

状态：accepted

目标批次见 [M5.4](../../plan/reprise-refactoring-execution.md#m54-单实验连续时间线)。

## 问题

Target 原始事件只按产品命名空间写入。TUI 投影依赖已安装 Pack 的 `translate`。程序重开或 Pack 缺失时无法阅读候选公开过程。候选开始会清空内存时间线，宽屏左右分栏替换整页历史。

## 决定

- 写入 Target 原始事件之后，由 application 用当前 Pack 译成通用 `runtime.public_activity`，payload 经 `PublicActivityPayloadSchema` 校验。
- TUI 只投影该事件与 Harness/Controller/Recovery/Comparison 事实。不加载 Pack。未知产品前缀事件做通用降级；delta/stderr 留在原始事件入口。
- 隐藏 reasoning/`thinking`，不画未公开推理。
- 同一实验时间线按持久化顺序连续追加。候选启动不清空恢复记录。宽屏单列。对照门叠在时间线下方，不换页清空。
- 任务判断、终止、清理分三条可见记录。取消请求文案不等于终态。历史打开实验时只读 `events.jsonl` 做同一投影。

## 备选方案

**重开时再加载原 Pack 翻译。** 违反历史查看不依赖插件。

**只持久化原始事件、TUI 内置各产品分支。** 把产品判断抬进宿主。

## 影响

旧日志没有 `runtime.public_activity` 时，产品事件只显示通用降级或留在原始记录。真实终端滚动与搜索属 M5.5。

## 验证

`test/timeline.test.ts`：公开活动可读、原始 `codex.*` 不出现 Pack 专属标题、thinking 不进主列、结局三条可见。`test/public-activity.test.ts`：非法 payload 不落盘。`test/architecture.test.ts`：TUI 不 import Pack 注册表；`beginRun` 不清空时间线。反向：TUI 再对 `codex.*` 调 Pack `translate`，或 `beginRun` 赋值空时间线，则红。
