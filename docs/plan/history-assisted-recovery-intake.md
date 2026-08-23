# 历史会话统一恢复入口改造计划

状态：已实施并验证（2026-08-16）  
范围：把 Claude Code 的完整 transcript 与 history-only 记录归一为同一条 `inspect → freeze → recovery → run` 用户流程；不扩大 Comparison HTML 报告范围。

## 目标

用户只需要选择一条会话。系统内部根据证据多少调整 Recovery Agent 的调查策略，不展示模式选择、证据等级开关或额外恢复确认。真实 Candidate 运行前现有的费用/外部调用确认继续保留。

```mermaid
flowchart LR
  A[选择会话] --> B[Inspect]
  B --> C[Freeze 为 TaskCase]
  C --> D[Recovery Agent 在隔离 staging 调查]
  D --> E[统一运行确认]
  E --> F[Candidate Run]
  F --> G[结果与限制]
```

## 已确认事实

- `~/.claude/projects` 目前有 32 个可回放 JSONL transcript；`history.jsonl` 有 128 个不同 sessionId，其中 113 个没有同名 transcript。
- 现有 Recovery Agent 的 `RecoveryContext` 已允许 `transcriptLength = 1` 与 `historicalEventCount = 0`；它以任务输入、Git、工作区、patch/preimage 和产品 playbook 调查 staging，不以完整 transcript 作为前置条件。
- 当前缺口是 Claude Pack 将 history-only 记录排除在 `SessionSummary` / `import()` 之外，导致它们无法进入 freeze 和 Recovery。

## 设计

### 1. 统一的会话证据契约

为 `SessionSummary` / `SessionInspection` / `ImportedSession` 增加产品中立的 `evidenceLevel`：

- `transcript`：来自完整产品 transcript；
- `history`：来自产品的历史索引，只有最小任务线索。

该字段供 Pack、freeze、Recovery 和报告使用；TUI 不根据它分叉用户操作。`TaskCase` 持久化该字段，使模型可见的恢复上下文和事件日志可复原。

### 2. Claude history-only Adapter

Claude Pack 读取相邻 `history.jsonl`，在不保存真实 sessionId、绝对路径或正文之外的敏感内容前提下：

- 将唯一 history 条目与现有 transcript 按 sessionId 去重，优先完整 transcript；
- 对缺 transcript 的条目创建可 inspect/import 的最小会话；
- 初始任务文本使用 Claude history 提供的显示输入；如果没有可用文本，该条目仍不进入选择列表，并以诊断说明；
- `inspect()` 返回最小 transcript（一个用户消息）、未知的历史基线与明确 `history` evidenceLevel；
- `import()` 构造可冻结的 `ImportedSession`，不伪造 assistant 回复、工具调用、提交或历史结果。

### 3. Freeze 与 Recovery

- `freezeCase()` 将 `evidenceLevel` 写入不可变 `TaskCase`；history-only 的 baseline 为空证据、没有 final message。
- `RecoveryContext` 将 evidenceLevel 交给 Recovery Agent；system prompt 要求它在 history 模式下把历史条目当作任务线索，优先验证 Git/工作区事实，不能声称找回未观察到的历史执行。
- Recovery 输出和现有 `recovery.md` 继续记录 observed / inferred / unresolved；Host 保持对 evidence refs、staging 与报告的验证。

### 4. TUI 简化

- 产品 → 项目 → 会话选择不显示“完整 / 可恢复”模式入口；两种会话都可按 Enter。
- 进入会话后一律执行 inspect、freeze 和 Recovery；恢复状态只作为运行准备的进度显示。
- 删除 history-only 的“已跳过”误导性统计；仅在 Recovery 无法建立可用 baseline 或最终结果存在限制时显示简短说明。
- 不移除真实运行前的统一确认页，因为它承担外部调用和费用边界确认。

## 实施步骤

1. 扩展产品契约与 `TaskCase` schema，并同步 freeze / redaction / 快照测试。
2. 实现 Claude history index 的 summary、inspect 和 import；完整 transcript 始终覆盖同 sessionId 的 history 条目。
3. 将证据等级输入 Recovery Context、提示词和恢复事件；保持 Agent 工具面不变。
4. 将 TUI 会话选择改为统一统计和统一进入路径。
5. 补充 Claude Pack、freeze、Recovery Context 和 TUI 回归测试。

## 实施结果

- 产品契约、冻结 TaskCase、Recovery Context 与 `recovery.started` 事件均已传递 `evidenceLevel`；旧 TaskCase 缺该字段时仍按 `transcript` 兼容。
- Claude Code Pack 已将 `history.jsonl` 中未被完整 transcript 覆盖、且含有效初始任务文本的条目纳入发现、inspect 和 import。
- TUI 已在 Preflight 后自动启动 Recovery；预检页不再接受“当前状态 / Recovery”分支按键，恢复期间仅显示“正在准备隔离环境”，完成后进入唯一的 Candidate 运行确认页。
- Recovery 系统提示词、TUI 审计脚本、系统提示词快照、生成事件文档和回归测试已同步更新。

## 验收

1. 临时 Claude root 中同时存在一个 transcript 与两个 history-only 条目时，列表有 3 条可选择会话，且不会重复 transcript 对应条目。
2. history-only 会话可完成 `inspect → import → freeze`；冻结结果满足 `TaskCaseSchema`，`evidenceLevel = history`，且不含伪造 assistant 输出或历史基线证据。
3. Recovery Agent 接到 history evidenceLevel 时仍获得最小任务输入，并在 prompt 中受到“不可把推断说成历史事实”的约束。
4. TUI 对两类会话使用同一个 Enter 流程；不会显示要求用户选择恢复模式的页面。
5. 完整 transcript 既有导入、分页、隐私和 Recovery 行为保持通过。
6. `npm run build`、受影响的 `dist` 测试、`npm run verify:docs` 与 `npm run check` 均通过。

验证记录（2026-08-16）：`npm run check` 通过，11 个门禁通过、0 失败。
