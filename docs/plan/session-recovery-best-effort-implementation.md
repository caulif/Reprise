# 会话恢复的尽力而为实施方案

## 目标

会话扫描的目标不是把每个文件都强行标成“可回放”，而是对每个被发现的 Codex 或 Claude Code 会话都完成一次可追踪的恢复尝试：

1. 文件存在且可读时，先按产品格式解析完整 transcript；
2. 格式不完整、尾部损坏、版本未知或消息结构变化时，尽可能保留可解析前缀和原始文件；
3. 只有确实无法生成合法用户输入时，才判定为“无法回放”，而不是在 discovery 阶段直接丢弃；
4. 用户可以看到失败原因、恢复级别和原始证据，并能重新尝试，而不是只看到笼统的 `unreadable`。

“所有会话都可以恢复”在工程上应落实为“所有会话都必须进入恢复管线并产生结果”。对于空文件、只有系统消息、源文件丢失等情况，不能伪造用户输入；此时保存不可回放的恢复记录仍然算作一次完整尝试。

## 当前根因

本机 Codex 数据位于 `~/.codex/sessions`。现有实现已经能枚举 rollout 和 SQLite catalog，但恢复资格仍然过度依赖摘要阶段的结果：

- Codex Desktop 使用 `response_item.payload.type=message`，并以 `payload.role` 区分 user/assistant；解析器主要覆盖 `event_msg.user_message` 和 `event_msg.agent_message`；
- 超过摘要预算的文件会退化为固定头读取。系统提示、`AGENTS.md`、workspace 状态可能占满头部，真正的用户消息不在窗口内时会被误报为缺少用户消息；
- `consumeCodexSummaryRow()` 和 `consumeCodexBuildRow()` 没有共享同一套消息抽取规则，摘要判定与完整导入可能不一致；
- discovery 失败会生成 `availability=unreadable`，恢复入口随后直接阻止，不再进行一次完整 inspect/import；
- catalog 合并时一方的 `unreadable` 可能覆盖另一方已经存在的 transcript 证据；
- Claude Code 的 history-only 记录可以展示，但没有本地完整正文，不能伪造成可回放 transcript。

本机最近一次扫描显示 1363 个 Codex 候选文件，其中 1302 个 indexed、40 个最终为 unreadable、21 个 catalog-only。不可读项中同时存在格式未支持、受限摘要误判、没有用户消息和非法 JSONL，必须拆开处理。

## 设计原则

### 1. 发现、解析、恢复资格分离

`discover()` 只负责回答“这个来源是否存在、能否读取部分元数据”。它不能提前决定“该会话永远不能恢复”。

建议将状态拆成两组：

```text
sourceAvailability:
  indexed | catalog-only | unreadable | missing

recoveryReadiness:
  verified | best-effort | history-only | no-user-input | corrupt | pending
```

`unreadable` 只用于 stat/权限/无法读取首行等硬错误；“摘要窗口内没有用户消息”使用 `pending`，交给完整恢复阶段验证。

### 2. 先尝试完整恢复，再做降级

对每个有本地文件的候选执行：

```text
stat + 稳定性检查
  -> 流式完整 JSONL 解析
  -> session id 校验
  -> 产品消息归一化
  -> 生成 verified 或 best-effort ImportedSession
  -> freeze/recovery intake 记录结果
```

不能用 256 KiB 头部结果替代完整恢复结果。头部只用于快速列表展示和排序。

### 3. 不伪造用户消息，但保留原始证据

以下内容不能被当成用户输入：

- system/developer 指令；
- `world_state`、tool output、reasoning；
- catalog 的 title/preview；
- Claude history 中没有对应 transcript 的 prompt。

如果没有合法用户消息，恢复结果应保存 `no-user-input` 和具体诊断，保留原始 rollout（若文件可读），而不是创建一个看似正常的 TaskCase。

### 4. 恢复结果必须可重复、可解释

每次尝试都记录：来源路径、session ID、文件大小和 mtime、解析到的物理行号、成功解析的消息数、跳过的事件数、首个错误及降级原因。不得记录 Codex/Claude 凭据或把敏感文本写入诊断日志。

## 具体修改方案

### 阶段 A：建立统一消息归一化器

修改：

- `src/products/codex/sessions.ts`
- `test/codex-pack-sessions.test.ts`

增加一个局部、产品专用的 `consumeCodexMessage()`，由摘要和完整构建共用。至少支持：

```text
 event_msg / user_message       -> user
 event_msg / agent_message      -> assistant
 response_item / message / user -> user
 response_item / message / assistant -> assistant
 response_item / function_call  -> tool
 response_item / function_call_output -> tool
 response_item / custom_tool_call -> tool
 response_item / custom_tool_call_output -> tool
```

从 `payload.content` 读取受支持的文本块：`input_text`、`output_text`、普通 `text`。未知块保留为事件但不冒充文本消息。摘要只累计计数和首条用户文本；完整构建生成 `SessionMessage`。

测试必须使用本机真实格式的最小 fixture，并覆盖旧格式、现代格式、混合格式、多个 content 块和未知 content 块。测试断言 discovery、inspect、import、freeze 使用同一用户消息计数。

**落地（已完成）。** 在 `src/products/codex/sessions.ts` 增加局部 `consumeCodexMessage()` 与 `extractCodexContentText()`；`consumeCodexSummaryRow` 与 `consumeCodexBuildRow` 都走它。Desktop `response_item`/`message` 从 `payload.content` 抽取 `input_text`/`output_text`/`text`，未知块只增加 skipped 计数。回归在 `test/session-recovery-best-effort.test.ts`：同一用户消息数贯穿 discover/inspect/import。

### 阶段 B：把摘要失败改成“待完整尝试”

修改：

- `src/products/shared/session-files.ts`
- `src/products/shared/session-recovery.ts`
- `src/products/codex/sessions.ts`
- `src/products/claude-code/sessions.ts`
- `src/products/contract.ts`

当完整摘要因 `too-large`、`line-limit` 或“头部未找到用户消息”失败时：

1. 保留 session ID、cwd、mtime、文件大小和 catalog 元数据；
2. 状态设为 `pending`/`best-effort`，不要立即生成最终 `unreadable`；
3. Enter 时强制调用完整 `inspect()`；
4. 完整解析成功则更新列表缓存并继续导入；
5. 完整解析失败才生成真正的错误分类。

为避免扩大公共契约，优先在 `SessionSummary` 增加结构化诊断字段；`SessionSourceAdapter` 仍保持 `discover/inspect/import` 三个入口。若现有 schema 不允许保存恢复诊断，先在 `src/core/schema.ts` 增加受控枚举和数组字段，并为持久化结果增加 `Value.Check`。

**落地（已完成）。** `SessionSummary`/`ImportedSession` 增加 `recoveryReadiness` 与 `recoveryDiagnostics`。`src/core/schema.ts` 增加 `RecoveryReadinessSchema`、`RecoveryDiagnosticSchema`、`SessionRecoveryAttemptSchema`。discovery 失败走 `discoveryFailureSummary()`：仅 stat/权限类硬错误为 `unreadable`；`too-large`、非法 JSONL、缺用户消息为 `indexed`+`pending`。完整摘要读完仍无用户消息记 `no-user-input`。`inspectBlockedReason` 允许 pending 进入完整 inspect；`importVerifiedSession` 经 `attemptSessionRecovery` 再决定能否 freeze。Claude 增加 `inspectPartial` 头摘要。

### 阶段 C：完整流式解析的降级策略

修改：

- `src/products/shared/jsonl-io.ts`
- 两个 Product Pack 的 sessions adapter

完整解析按以下策略执行：

1. 文件稳定时从头到尾逐行解析；
2. 尾部在写入中或遇到最后一行非法 JSON 时，保留此前成功解析的记录并返回 `best-effort`；
3. 非尾部非法 JSON 默认返回 `corrupt`，但仍保留已解析前缀和 raw 文件；
4. session metadata 缺失时，可以使用已验证的 catalog ID，但必须检查 transcript 中是否存在同一 ID；不能仅凭文件名猜测；
5. 解析遇到未知事件类型时跳过该事件并计数，不因未知事件终止整个会话；
6. 文件在读取期间变化时重新 stat；若大小/mtime变化，重新读取一次稳定快照，第二次仍变化则返回 `pending`，允许用户重试。

`best-effort` 导入必须携带诊断，且 freeze 的 raw 与计算 hash 必须来自同一快照。已有的大文件流式读取和快照 hash 逻辑继续复用，不增加第二份完整 Buffer。

**落地（已完成）。** `jsonl-io.ts` 增加 `forEachJsonlRecordLenient` 与 `withStableJsonlRead`。非法 JSON 后继续看是否还有非空行：无则为 `truncated-tail`/`best-effort`，有则为 `invalid-jsonl`/`corrupt` 并停止消费后续行。stat 变化重试一次，仍变化则 `pending`。缺少 `session_meta` 时仅当 transcript 中出现与 catalog 相同的已校验 ID 才采用该 ID。未知行类型计入 skipped。strict `forEachJsonlRecord` 仍按物理行号抛错。

### 阶段 D：放宽恢复入口，但保留安全边界

修改：

- `src/products/shared/session-recovery.ts`
- `src/application/recovery-selection.ts`
- `src/ui/pages/intake.ts`
- 相关 TUI 测试

恢复入口按结果分流：

```text
verified       -> 正常 freeze / replay
best-effort    -> 允许 freeze，界面显示缺失部分和诊断
corrupt        -> 允许保存“部分恢复证据”，默认不进入真实 replay
no-user-input  -> 保存不可回放恢复记录，要求用户不能伪造输入
history-only   -> 允许查看/保存 history 证据，不进入 transcript replay
catalog-only   -> 保存 catalog 线索，等待用户提供或重新发现源文件
missing        -> 记录 source-missing，并提供重新扫描
```

现有 `isEligibleSession()` 对完整可回放 TaskCase 的约束继续保留：不能因为用户要求“全部恢复”而用 developer/system 文本填充 initial input，也不能把没有完成 turn 的文件伪装成已完成任务。

新增“尝试恢复”动作时，结果至少包括：

```text
attempted: true
status: recovered | partial | not-replayable | retryable
sourcePath
sessionId
parsedMessageCount
skippedEventCount
diagnostics[]
rawSnapshotPath 或已冻结 raw
```

UI 不再只显示 `Selected session transcript is unreadable.`，而是显示：

```text
已尝试恢复，但只能得到部分正文：Codex Desktop message format / JSONL line N / no user input
```

**落地（已完成）。** `attemptSessionRecovery` 产出 `SessionRecoveryAttempt` 并 `Value.Check`。`freezeBlockedReason` 增加 `no-user-input`/`corrupt`；pending 不拦截 inspect。`importVerifiedSession` 在 recovered/partial 时返回 `ImportedSession`，否则抛出带诊断的中文摘要。TUI `sessionStatus` 显示 pending/best-effort/no-user-input/corrupt；检查页列出 `recoveryDiagnostics`。`isEligibleSession` 未放宽。计划中的 `src/ui/pages/intake.ts` 实际路径是 `src/tui/pages/intake.ts`。

### 阶段 E：修正 catalog 合并优先级

修改：

- `src/products/codex/sessions.ts`
- `src/products/codex/catalog.ts`
- `test/codex-intake.test.ts`

合并规则按证据强度排序：

```text
verified transcript > best-effort transcript > catalog metadata > missing source
```

catalog 的 `indexed` 不得覆盖一个完整解析成功的 transcript；摘要失败也不能覆盖完整 inspect 成功的结果。合并时保留两侧诊断，不使用单个 `unreadable` 布尔值抹掉更强证据。

按 session ID 和 canonical source path 去重；当同一 ID 存在多个 rollout 时，逐个尝试解析，优先选择可验证且时间最新的来源；只有全部来源失败才报告 `unreadable`。

**落地（已完成）。** `mergeCodexSources` 改为 `evidenceRank()`：verified > best-effort > 有用户消息的 transcript > pending > catalog-only > unreadable。胜者保留路径与 signals，合并两侧 `recoveryDiagnostics` 与 cwd。同 ID 不同 path 仍记 `duplicate-source`。决策见 [2026-08-27-session-recovery-best-effort.md](../decisions/accepted/2026-08-27-session-recovery-best-effort.md)。

## 建议的最小数据模型

不建议立刻引入复杂状态机；先在已有类型上增加有限字段：

```ts
type RecoveryReadiness =
  | 'verified'
  | 'best-effort'
  | 'pending'
  | 'history-only'
  | 'no-user-input'
  | 'corrupt';

type RecoveryDiagnostic = {
  code: string;
  message: string;
  physicalLine?: number;
};
```

`availability` 继续表达源文件是否存在/可读，`recoveryReadiness` 表达正文能否恢复。两者不能互相替代。

## 测试与验收

### 单元测试

- Codex 旧 `event_msg` 格式；
- Codex Desktop `response_item/message` 格式；
- Codex 新旧混合格式；
- developer/system 消息不计为 user；
- 用户消息位于 256 KiB 之后；
- 用户消息位于 4 MiB 之后；
- 大文件流式 inspect/import；
- 尾部非法 JSON 的部分恢复；
- 非尾部非法 JSON 的诊断与 raw 保留；
- 无用户消息、无 completed turn、仅 catalog、history-only；
- catalog 与 transcript 的证据优先级；
- session ID 不一致必须拒绝；
- Windows extended path 和文件变化重试。

### 端到端验收

使用本机真实路径执行一次 Codex 和 Claude Code 扫描，输出以下统计：

```text
发现总数
已尝试恢复数
verified 数
best-effort 数
retryable 数
not-replayable 数
仅 catalog 数
真正读取失败数
```

验收条件：

1. `已尝试恢复数 = 所有存在候选来源数`；
2. 现代 Codex Desktop 会话不再因 `response_item/message` 缺失适配而统一变成 unreadable；
3. 用户消息在摘要窗口之外的会话可以进入完整 inspect；
4. 每个失败项都具有可操作诊断，而不是只有通用错误；
5. verified 和 best-effort 会话均能保存 raw 快照；
6. no-user-input、history-only、catalog-only 不被伪造成可回放任务；
7. 运行 `npm run check` 通过；
8. 文档变更运行 `npm run verify:docs` 通过。

## 实施顺序与回滚边界

按以下顺序落地，每一步都能独立验证：

1. 统一 Codex 消息归一化器和现代格式回归测试；**已完成**（`consumeCodexMessage` + `test/session-recovery-best-effort.test.ts`）。
2. discovery 摘要状态与完整 inspect 解耦；**已完成**（`recoveryReadiness=pending`，`discoveryFailureSummary`）。
3. 完整 JSONL 的尾部降级和稳定快照重试；**已完成**（`forEachJsonlRecordLenient` / `withStableJsonlRead`）。
4. recovery intake 的 best-effort 分流；**已完成**（`attemptSessionRecovery` + TUI 诊断）。
5. catalog 合并证据优先级；**已完成**（`evidenceRank` / `preferCodexEvidence`）。
6. 本机 Codex/Claude Code 全量报告和 TUI 验收。**代码路径已就绪**；全量本机扫描报告需在真实 `~/.codex/sessions` 上单独跑，不作为默认 `npm run check` 的一部分。

每一步只改变对应状态和入口，不删除原始会话文件，不修改 Codex/Claude 凭据，不覆盖现有 TaskCase。若某一步失败，可回退该步骤的状态映射而保留前一步的 parser 和测试。

## 非目标

- 不读取或保存 Codex、Claude Code 凭据；
- 不把 system/developer/reasoning/tool 数据伪装成用户输入；
- 不承诺损坏或已删除文件能够还原原始内容；
- 不用提高内存上限替代流式解析；
- 不通过绕过 `sessionId`、JSON schema 或路径边界来“恢复”会话。
