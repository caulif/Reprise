# 决策：列表展示、冻结资格与 Recovery Agent 分界

状态：accepted

## 问题

会话列表用有界摘要窗口生成标题和粗略计数。若把窗口里看不到用户消息、或 `pending` 摘要，当成冻结资格或 Recovery Agent 的入口判断，会出现两类错误：可回放会话被列表永久挡在 inspect 之外；或把「能不能 freeze」交给模型，编造 `initialInput`。

## 决定

三条管线分开，且都不把冻结资格交给 Recovery/Controller/Comparison：

1. **列表只截断展示。** `discover()` 的 256 KiB / 4 MiB 窗口只服务标题、时间和粗略计数。窗口不够标「摘要不完整」或 `pending`。`freezeBlockedReason` 只拦截 inspect 无法修复的来源（catalog-only、history-only、硬 unreadable）。列表上的 `no-user-input` / `pending` 不是冻结门禁。
2. **冻结资格只在选中之后、由确定性 Case Preparation 给出。** Enter 必须完整 `inspect()`，再 `import`/`freeze`。可回放、best-effort 部分正文、不可回放（无合法用户输入、corrupt、history-only、catalog-only）都以 inspect 结果为准。禁止用 system/developer/catalog 标题伪造用户输入。
3. **Recovery Agent 只在已有 `TaskCase` 之后接手。** 它恢复 EnvironmentBaseline，不解析产品 JSONL，不改 `TaskCase.initialInput`，不重新挑选会话。导入不可回放时不启动 Recovery Agent。

TUI 按管线阶段显示「摘要不完整，正在完整读取」「已冻结，进入环境恢复」「无法回放：没有合法用户输入」，不把三种情况都写成不可读。

## 备选方案

**让 Recovery Agent 读 JSONL 并决定能不能 freeze。** 同一会话每次 freeze 可能得到不同 `initialInput`，且 TUI 会投影未写入事件日志的推理。

**提高摘要内存上限代替完整 inspect。** 把列表成本变成全量加载，仍无法处理写入中的尾部。

**继续用列表 `recoveryReadiness` 作为 `freezeBlockedReason`。** 完整摘要窗口外的用户消息会被永久挡在 inspect 之外。

## 影响

- Product Pack `discover()` 继续有界；`inspect`/`import`/`freezeCase` 仍是确定性 Case Preparation。
- Recovery Playbook 不得指示 Agent 解析产品 JSONL 或替换 `initialInput`。
- 硬 stat/权限失败仍可在列表标 `unreadable`，但保留行以便重试扫描。

## 验证

- `test/session-recovery-best-effort.test.ts`：列表 `pending` 的 `freezeBlockedReason` 为空；用户消息在 4 MiB 窗口外仍能 `importVerifiedSession`；inspect 后的 `no-user-input` 抛 `SessionReplayError`。
- `test/architecture.test.ts`：Recovery Agent、recovery 工具与 experiment-recovery 不 import `jsonl-io` 或产品 `sessions` 解析器。
- `test/widgets.test.ts`：列表 `pending` 显示摘要不完整，不显示 unreadable。
- `npm run check`
