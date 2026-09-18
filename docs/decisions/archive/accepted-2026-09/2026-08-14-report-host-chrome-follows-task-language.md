# 决策：报告 Host 壳跟随任务语言

状态：accepted

## 问题

Comparison 已按 `initialInput` 的主要语言写 `comparison.md`，但 `report.html` 的题头、对照条、停止原因和回放限制是 Host 写死的英文。只改 `html lang` 不够：用户打开中文任务的报告，第一屏仍是 English chrome。这与规划里「跟随用户语言」冲突，也容易被误判成 Comparison 没遵守语言规则。

## 决定

Host 渲染的报告壳（题头、对照条标签、降级说明、停止原因、回放限制句）跟随 `initialInput` 的主要语言，现为中/英。语言由 Host 从任务文本判定，不读 TUI `/lang`。模型名、路径、终止码、`permissionMode=` 和 `sourceRootKind=` 前缀保持原文。Comparison 与 Controller 的 system prompt 仍用英文；Comparison briefing 在中文任务上收到中文 Host 条件，便于它复述而不是把英文限制抄进正文。

## 备选方案

**只改 `html lang`，壳保持英文。** 这是上一轮的做法。`lang` 对屏幕阅读器和字体有用，但用户看见的仍是英文标签，问题没有消失。

**复用 TUI `/lang`。** TUI 语言是操作者偏好；报告语言是这次任务的语言。一份英文任务不应因为操作者把 TUI 调成中文就改写 Host 事实句。两套词汇可以平行存在。

**让 Comparison 把壳也写成 Markdown。** 壳是 Host 核验事实，不能从 Agent 正文反解析。把标签交给模型会重新引入排名腔和语言漂移。

## 影响

- `src/report/copy.ts` 持有报告壳文案；`describeStop` / `hostReplayConditions` 接受 `lang`。
- 英文任务的既有测试与夹具报告保持英文。
- 真机 e2e 的报告字符串检查同时接受中英。

## 验证

`test/comparison-report.test.ts` 用中文 `initialInput` 断言「Reprise 比较」「不是排名」「回放限制」，并断言不出现 `Host contrast`。英文任务夹具仍匹配 `Reprise comparison`。
