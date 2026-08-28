# 列表展示、会话冻结与 Recovery Agent 的分界

## 要回答的问题

列表摘要截断是否可以只影响展示、不影响冻结？“能不能冻结、能不能恢复”是否应该交给 Agent？

结论：**展示可以截断；冻结资格不能由列表决定，也不能由 Recovery Agent 决定。** 用户选中会话之后，由 Case Preparation 做完整、确定性的 inspect/import/freeze；**只有环境怎么补全**才交给 Recovery Agent。

权威分层见[架构总览](../architecture/overview.md) §3.1 与[环境设计](../architecture/environment.md)。列表与摘要窗口见[TUI](../product/tui.md) §3.3。正文分级见[会话恢复按 readiness 分级](../decisions/accepted/2026-08-27-session-recovery-best-effort.md)。

## 分析：两个“恢复”不是一件事

Reprise 主路径是：选历史会话 → 冻结 `TaskCase` → Recovery Agent 恢复**执行前环境** → 候选 Runtime 重做任务 → Comparison。

| 步骤 | 负责者 | 它回答的问题 | 能否用模型临场判断 |
| --- | --- | --- | --- |
| 列表摘要 | Product Pack `discover()` + TUI 投影 | 这条来源是否存在、标题/时间够不够扫一眼 | 否。摘要窗口截断只影响展示 |
| 导入与冻结 | Case Preparation：Pack `inspect`/`import` + `freezeCase` | 能否得到合法用户输入、transcript、raw 快照和 `TaskCase` | 否。进入模型请求的输入必须能从事件日志复原；不能让模型编造 `initialInput` |
| 环境恢复 | Recovery Agent + Environment Provider | 历史 cwd、文件、Git 等在隔离副本里如何补到可跑 | 是。这是不完整证据上的语义动作；Provider 独立验证 |

[架构总览](../architecture/overview.md)写明：Case Preparation **不使用 Agent 判断任务边界**；用户选中的逻辑会话直接成为 `TaskCase`。Environment 子系统**不负责**解析 Claude/Codex 私有事件格式。Product Pack 的 `session-source` 负责发现和导入；`recovery/SKILL.md` 只给 Recovery Agent 用。

因此“冻结和恢复都放到 Agent 侧”如果是指 **Recovery Agent 读 JSONL、决定能不能 freeze**，会和现有架构冲突：

- 同一会话每次 freeze 可能得到不同 `initialInput`，实验不可比；
- TUI 会伪造未在事件里出现的推理（[TUI](../product/tui.md) 禁止）；
- 系统/developer/`AGENTS.md` 可能被模型当成用户任务，这正是 recovery 管线要禁止的。

如果“Agent 侧”是指 **不要在列表层判决，把完整尝试放到用户点选之后的准备管线**，则与架构一致：列表不是判决器；inspect 在应用层确定性执行；随后的环境恢复才是 Recovery Agent。

## 要如何改

### 1. 列表只做截断展示

`discover()` 继续用 256 KiB / 4 MiB 窗口生成标题、时间和粗略计数。窗口不够就截断或标“摘要不完整”。**列表状态不得等价于冻结资格。** 用户看到残缺摘要，仍可 Enter 触发完整 inspect。

硬错误（stat/权限、文件不存在）可以在列表上标明来源不可读，但仍保留行，让用户能重试扫描；不要用摘要窗口里“没看到用户消息”冒充硬错误。

**落地（已完成）。** `freezeBlockedReason` 只拦 catalog-only / history-only / 硬 unreadable。列表 `pending`/`no-user-input` 不再当作冻结门禁。TUI 将 `pending` 与 `partial` 显示为摘要不完整。

### 2. 冻结资格只在选中之后、由确定性管线给出

Enter / freeze 必须走完整流式 `inspect()`，再 `import`/`freeze`。结果分三类，都来自 Pack 与 Case Preparation，不来自列表缓存，也不来自 Recovery Agent：

- 可回放：有合法用户输入，且满足现有 `isEligibleSession`（完成 turn + assistant/tool）。生成 `TaskCase`。
- 部分正文：尾部损坏等 `best-effort`，仍有合法用户输入则可冻结，界面展示诊断。
- 不可回放：无用户输入、history-only、catalog-only、corrupt 默认不进真实 replay。保存诊断和原始证据，禁止用 system/developer/catalog 标题伪造用户输入。

Session ID、JSON schema、路径边界不得为了“多恢复几条”而绕过。

**落地（已完成）。** `replayBlockedAfterInspect` 只看完整 inspect。4 MiB 窗口外的用户消息可 `importVerifiedSession`。不可回放抛 `SessionReplayError`，不启动 Recovery。

### 3. Recovery Agent 只在 TaskCase 之后接手

冻结成功后，Recovery Agent 只处理 EnvironmentBaseline：历史工作区、文件、Git、Playbook 允许的动作。它不解析产品 JSONL，不改 `TaskCase.initialInput`，不重新挑选会话。Provider 验证并发布 baseline；用户确认后再开候选运行。

不可回放的导入结果**不要**启动 Recovery Agent 去“编一个能跑的任务”。

**落地（已完成）。** `startRunSetup` / `beginPreflight` 要求已有 `taskCase`。`importVerifiedSession` 失败走错误页。architecture 测试禁止 recovery 栈 import JSONL 解析器。Playbook 写明不得解析产品 JSONL 或替换 `initialInput`。

### 4. TUI 的职责

TUI 是事件日志的只读投影：显示截断摘要、完整 inspect 的诊断、能否进入准备并开始。它不持有实验状态机，不用模型口头解释“为什么不可读”来代替 Pack 诊断。

点选后的文案应对齐管线结果，例如“摘要不完整，正在完整读取”“已冻结，进入环境恢复”“无法回放：没有合法用户输入”，而不是把三种情况都写成不可读。

**落地（已完成）。** freeze 按列表是否摘要不完整选择读取文案；冻结成功且 `thenRun` 时 `beginPreflight` 使用“已冻结，进入环境恢复”；`SessionReplayError` 映射到分项无法回放文案。

### 5. 明确不改

- 不把 JSONL 解析或 freeze 门禁交给 Recovery/Controller/Comparison。
- 不提高摘要内存上限来代替完整流式 inspect。
- 不读取 Codex/Claude 凭据。
- 不承诺损坏或已删除文件能还原原文。

**落地（已完成）。** 约束写入 [列表展示、冻结与 Recovery Agent 分界](../decisions/accepted/2026-08-27-session-intake-vs-recovery-agent.md)。

## 验收

- 用户消息落在摘要窗口之外时，列表可以截断，Enter 仍能完整 inspect 并在有合法用户输入时冻结。
- 列表缓存为 `pending` 或摘要不完整的行，不得在未 inspect 前被 TUI 永久标成不可冻结。
- Recovery Agent 的工具面和 Playbook 仍看不到产品私有 JSONL 解析器；环境恢复测试不依赖改 `initialInput`。
- `npm run check`；若只改文档则 `npm run verify:docs`。
