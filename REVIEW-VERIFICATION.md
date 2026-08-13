# FIRST-PRINCIPLES-REVIEW 落地核查报告

日期：2026-08-13
方法：逐项对照 `FIRST-PRINCIPLES-REVIEW.md` 行动清单与当前源码；`npm run typecheck` 通过，`npm test` 64/64 通过。

## 总体结论

**价值链主干（P0-3 → P0-5 → P0-7/P0-8）已全部打通**：freeze 采集环境与行为证据 → Controller 每轮收到确定性蒸馏观察包 → 报告两列并排真实事实与真实指标。三个专项审视（第 6/7/8 节）指出的核心断点全部修复，这是本轮改动最有价值的部分。

未落实的集中在两类：**P1-2 仪式性保真（一处都没动）** 和 **P2 代码卫生（临时文件、.gitkeep、重复原语原样保留）**。另有若干"部分落实"的边角，详见下表。

## 逐项核对

### 顶层清单（第 3 节）

| 事项 | 结论 | 证据 |
|---|---|---|
| P0 方案 B：报告去倾向化 + 单次运行标注 | ✅ 已落实 | 报告标题 "Replay inspection (single run; not a ranking)"；投影纯事实并排，无 better/worse 语言 |
| P0 方案 B：README 措辞对齐 | ⚠️ 部分 | README 第 3 行仍是"用于在真实任务上**比较** Agent Runtime"，未改为"重放与检视"定位 |
| P1 README 断链 `docs/codex-smoke-gate.md` | ❌ 未落实 | `.gitignore` 第 45 行仍整体忽略 `/docs/`，README 第 62 行仍链接该文件，克隆者拿不到 |
| P1-2 删除伪溯源哈希 | ❌ 未落实 | `codex-experiment.ts` `resolvedAgentConfig` 仍在哈希常量标签（`hash('reprise-controller-prompt-v1')`） |
| P1-2 删除死配置字段 | ❌ 未落实 | `schema.ts`：`RunPolicy.heartbeatTimeoutMs` 仍必填且无任何消费者；`maxTokens`/`maxCost`、`AgentBudget.maxCalls/maxTokens/maxCost` 仍在 |
| P1-2 `validateCandidate` 并入端口 | ❌ 未落实 | `resolveVerifiedCandidate` 仍用 duck-typing（`runtime as RuntimePort & Partial<CandidateValidator>`） |
| P2 统一 harness 配置 | ❌ 未落实 | `commands.ts` 的 `HarnessConfig`/`config.json` 与 `harness-model-config` v2 仍并存 |
| P2 收敛 SAFE_ID/hash/writeImmutable | ❌ 未落实 | SAFE_ID 仍在 4 个文件、hash 3 处、writeImmutable 2 处各写一份 |
| P2 删根目录临时文件与 .gitkeep | ❌ 未落实 | 根目录 12 个 `.typecheck*`/`.errors*` 文件、src/test 下 9 个 `.gitkeep` 原样保留；`.gitignore` 未加忽略行 |

### Case Preparation 专项（第 6 节）

| 事项 | 结论 | 证据 |
|---|---|---|
| P0-3 freeze 采集确定性环境证据 | ✅ 已落实 | `sessions.ts`：`historicalEnvironment`（cwd 现状、git repo/HEAD/dirty）、`historicalBehavior`（命令 + 触碰文件）、`historicalCommit`（session_meta git 字段）全部写入 `taskContext` |
| P0-4 环境语义收敛 replay-from-current | ✅ 已落实 | `preflightFromBaseline` 删掉了 fingerprint 死分支，固定标注 "Replay starts from the selected directory's current state…"；TUI 用一次 [Enter] 确认替代 [o] 仪式 |
| P0-4 replay-from-commit | ❌ 未落实 | `historicalCommit` 采集了但没有任何消费者：无确定性 checkout 路径（见新发现 1） |
| P1-4 Recovery 按需化 | ⚠️ 部分 | 无线索确定性跳过（不调 LLM、不拷树）已落实；但 git 场景确定性 checkout、恢复产物回写 case 未做——由于 freeze 从不写 `recoveryClues`，真实路径 Recovery 恒跳过，Agent 通路成了不可达代码（见新发现 1） |
| P2-3 /run 预填 historicalCwd | ✅ 已落实 | `codex-intake.ts` source 页预填并提示确认 |
| P2-3 inspection 页可选任务起点消息 | ❌ 未落实 | inspection 页只展示，`initialInput` 仍机械取第一条 user 消息 |

### Candidate Run 专项（第 7 节）

| 事项 | 结论 | 证据 |
|---|---|---|
| P0-5 确定性蒸馏观察包 | ✅ 已落实 | `inspectRun`：settlement 状态、最终 assistant 消息、命令、changedPaths、被拒审批，纯投影生成 `currentSummary`/`trajectorySummary`，占位常量已删 |
| P0-6 budget 传真实决策预算 | ✅ 已落实 | `SteeringContext.budget` 改为 `decisionsUsed`/`decisionsLimit`（= maxModelCalls） |
| P0-6 预算耗尽不记 failed | ✅ 已落实 | `limit.target_turns` 改为 `shutdown`；`terminationFor` 对 `limit.*` 记 `limit_reached`；`assessmentFor` 记 `incomplete` 而非 failed |
| P0-6 `requiresRealUserDecision` 处理 | ✅ 已落实 | 已从 SteeringContext 删除，system prompt 保留 done 语义 |
| P0-6 capabilities 对齐 | ❌ 未落实 | `controller-agent.ts` 仍声明 `['read_observation', 'read_artifact', 'read_transcript']`，实际注册的只有 `read_observation` 一个工具 |
| P0-6 删 `{ model: 'configured' }` 占位 | ❌ 未落实 | `codex-experiment.ts` `controller.started` 事件 payload 原样保留 |
| P1-5 会话经济二选一 | ⚠️ 部分 | `priorDecisions` 已从 context 删除（主要重复消除）；但持久 session + 每轮全量重发 `task.initialInput`/`baseline` 仍并存，静态部分每轮重复 |
| P1-6 审批拒绝浮出 | ✅ 已落实 | `rejectedApprovals` 进观察包与 currentSummary；报告 Limitations 固定呈现"候选请求 N 项审批被拒；历史用户可能会批准" |
| P2-4 模型目录验证复用 | ❌ 未落实 | `validateCandidate` 每次调用都 `listModels`（spawn 临时 app-server）；preflight 与 start 各一次，双 spawn 依旧 |

### Comparison Projection 专项（第 8 节）

| 事项 | 结论 | 证据 |
|---|---|---|
| P0-7 报告两列并排 | ✅ 已落实 | `renderTask` facts-grid：历史侧 finalMessage + 命令 + 触碰文件 vs 候选侧最终消息 + changedPaths + 命令；数据来自 P0-3 与 inspectRun |
| P0-8 真实指标 | ✅ 已落实 | telemetry 改为 Turns / Wall-clock / Changed files / Tokens，从持久化事件确定性计算；事件序号仅作无 inspection 时的降级 |
| P1-7 叙事内嵌 + 蒸馏 context | ✅ 已落实 | comparison.md 以 `<pre>` 内嵌 report.html；`ComparisonContext.candidates[].summary` 用 `inspectionSummary` 蒸馏事实替代一行状态码 |
| P1-8 artifacts catalog 真实 manifest | ✅ 已落实 | `finishExperiment` 传 `store.listArtifacts` 结果，kind/mediaType/byteLength 如实呈现 |

## 新发现的优化点

**1. `historicalCommit` 与 `recoveryClues` 之间断了一根线（承接 P0-4/P1-4，建议下一个 P1）**
freeze 现在会采集 `historicalCommit` 和 git HEAD/dirty，但 `recoveryClues` 永远不被写入，`replay-from-commit` 也没有任何消费者。结果是：Recovery Agent 及其全套 staging 工具（`stagingTools`、`recoveryNetworkTool`、`prepareRecoveryStaging`/`freezeRecoveryStaging`）在真实路径上是**不可达代码**。两个克制的选择：
- 兑现：cwd 是 git repo 且有 `historicalCommit` 时，在 prepareRun 后确定性 `git checkout`（不需要 Agent），这是 replay-from-commit 的最小实现；
- 或收缩：既然 Recovery 恒跳过，把 Agent 通路和 staging 工具显式搁置（删除或标注），与"死代码不留"的原则一致。
二选一，不要维持"机器在、路不通"的现状。

**2. `wallClockMs` 对最常见的单轮运行恒为 undefined（P0-8 的精度缺口，半小时）**
`inspectRun` 用 `runtime.turn_settled` 事件的首尾 `occurredAt` 差计算 wall-clock，需要 ≥2 次 settlement。而真实路径下候选一轮完成、Controller 直接 done 是常态——此时报告不显示 Wall-clock。建议起点改用 `input.submitted`（或 `run.state_changed` 首个事件），终点用最后一次 settlement。

**3. 每轮 Controller 决策前全树 fingerprint（性能提醒，暂不动）**
`inspectRun` 在 controller loop 每轮调用 `workspaceProvider.fingerprint`（全树遍历）。maxModelCalls=3 时最多 3 次，可接受；但若未来放宽预算或工作区很大，这里是已知热点。现在不改，记录在案。

**4. `controllerEvidence = input.targetEvents.slice(-64)` 是死赋值（一行清理）**
`runControllerLoop` 第 272 行 submit 后的赋值在下一轮循环开头立即被 `observation.evidenceRefs` 覆盖，且初始赋值（第 243 行）同理。删掉两处即可。

**5. `environmentBaseline` 字段成了新的仪式残留（schema 演进时顺手做）**
P0-3 的丰富数据全部写进了 `taskContext.historicalEnvironment`，而 schema 里的 `environmentBaseline` 仍旧硬编码 `'partial'/'unavailable'` + 空 artifactRefs，`fingerprint` 字段永远不写。老的死路径删了，但空壳字段留下了。下次 schema 版本演进时把 `environmentBaseline` 收窄或并入 `taskContext`，与 P3（candidates 收紧单候选）同批处理。

**6. token 事件匹配过宽（留意即可）**
`totalTokenCount` 用 `event.type.includes('token_count')` 模糊匹配并累加所有轮次的值。若 Codex 的 token_count 通知是**累计值**而非增量，求和会高估。首次真实运行时对照一次原始事件确认语义，再决定是否改为取最后一个值。

## 遗留项的建议处理顺序

1. **一小时内可清完的卫生债**：删 12 个临时文件 + 9 个 `.gitkeep`，`.gitignore` 加 `/.typecheck*`、`/.errors*`；README 第 3 行措辞改为"重放与检视"；smoke-gate 文档单独入库或改行内摘要。
2. **半天的诚实化收尾（P1-2 + P0-6 残留）**：删三个常量哈希字段、删 `heartbeatTimeoutMs` 等死配置、`validateCandidate` 并入 `RuntimePort`、capabilities 对齐、删 `{ model: 'configured' }`。这些都是审视文档反复强调的"仪式性保真"，是当前与项目价值观差距最大的一组遗留。
3. **按需再做**：P2-4 目录验证复用、P1-5 增量 context、新发现 1 的二选一。

## 克制提醒

本轮已落实的部分没有出现过度工程的迹象：观察蒸馏是纯投影、报告仍是静态 HTML、Recovery 收缩为按需。上表遗留项均为**删除或对齐**性质的工作，不引入新抽象；新发现 1 若选"兑现"路线，也应止步于一次确定性 `git checkout`，不要演化成环境编排器。
