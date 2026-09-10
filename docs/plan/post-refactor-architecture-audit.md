# 全项目重构后续审查与剩余问题清单

状态：proposed，供下一轮审查与修正使用

## 审查范围

本审查覆盖 Core 协议与 Schema、Application 编排、Recovery/Environment、Product Pack、Claude Code/Codex Runner、Reprise Agent Host、Comparison、TUI/CLI、持久化、测试和文档。构建、项目门禁、Node 测试和 TUI 帧审计均应作为本清单的验证证据；本文件不把通过门禁等同于架构完全正确。

## 当前结论

重构主链已经形成：

```text
ProductPack.history → observations → Recovery → CandidateLaunchContext
→ CandidateRun → ProductRuntime/TargetRunner → Runtime Journal
→ UserSurfaceProjection → Controller briefing
→ sealed history/candidate materials → Comparison
```

当前没有发现会阻止编译或门禁的错误。仍需处理的主要问题属于协议收敛、职责清理、文档一致性、可恢复性和实现重复；它们会影响长期维护或极端失败场景。

## P1：Application 仍过度集中

### 现象

`src/application/experiment.ts` 仍同时编排启动、Controller 循环、Runtime Journal 校验、用户视图物化、workspace fingerprint、artifact capture、Comparison 等多个边界。虽然辅助文件已经拆出，但该文件仍是多个模块的隐式总线。

### 影响

- Application 可能重新承担 Product Projection 和 CandidateRun 事实判断；
- 失败清理路径难以独立验证；
- persisted comparison、正常运行和取消路径容易出现不同顺序。

### 规划

将 `experiment.ts` 收敛为阶段编排器，只保留：创建上下文、调用端口、阶段顺序和终态传播。将以下逻辑分别放入稳定端口或专用服务：

```text
candidate-run.ts       状态、幂等、turn 和终止
controller-queries.ts  已持久化事实的观察投影
controller-briefing.ts 用户视图文件物化
candidate-run-events.ts Journal 事件校验
candidate-run-cleanup.ts stop/capture/release
comparison-briefing.ts  Comparison 资料物化
```

验收：编排器不能导入产品私有事件解析函数；任何 CandidateRun 状态只能通过 CandidateRun 方法变化；正常、取消、失败和 persisted comparison 复用相同的收尾语义。

## P1：Runtime 事件 Envelope 与 Product payload 的边界

### 现状

标准事件的 `eventId`、`sequence`、`type`、`occurredAt` 由 `EventEnvelope` 持有，`sessionId`、`turnId`、`messageId`、`callId` 和 `evidenceRefs` 由 CandidateRuntime payload 持有。这一设计已有决策和 Schema 支持，但部分调用方仍把 Runtime 事件当成普通 `TargetEvent`。

### 规划

- 所有 Product Adapter 只能调用一个统一的 `appendCandidateRuntimeEvent` 边界；
- 该边界负责补齐 run/session 所有权、Schema 检查、证据引用检查和 Journal 写入；
- Application 不再直接组装 `runtime.*` Envelope；
- `TargetEventSink` 应缩小为候选 Runtime 专用接口，避免普通环境事件混入；
- 对迟到、重复、错误 sessionId 或非法 sequence 明确拒绝并记录诊断。

验收：源码中除 Journal 边界外不再出现手写 `runtime.<type>`；所有事件都能关联一个 CandidateRun 和真实 sessionId。

## P1：Controller 用户视图与旧资料树的交叉检查

### 现状

生产源码已使用 `current-user-view.md`，但 Controller 的历史资料树仍同时维护历史文本、用户输入索引、THIS-TURN、当前 view 和事件索引。需要确认这些文件的 digest、manifest 和 `INDEX.md` 更新是否总是原子地处于同一版本。

### 规划

将一次 settled turn 的 briefing 写入视为一个发布操作：先写不可变 turn 目录，再校验所有文件，最后原子替换当前入口和索引。任何一步失败不得触发 Controller；manifest/digest 必须对应同一版本。

验收：模拟写入中断时 Controller 只能看到上一份完整视图或明确 unavailable，不会看到混合版本。

## P1：Comparison 封存输入的生命周期

### 现状

Comparison 依赖历史和候选封存材料。需要核对 `experiment-report.ts`、`comparison-briefing.ts`、persisted comparison 入口是否都拒绝活动 workspace，并且候选 cleanup unknown 时仍正确标记不可用资源。

### 规划

- CandidateRun 终态先固化 cleanup 和 artifact refs，再发布 Comparison attempt；
- 活动 `runs/{runId}` 只能作为运行中诊断，不能作为 Comparison 的终态输入；
- `snapshotStatus=unknown/incomplete` 必须在资料索引中显式展示；
- Comparison 失败不得修改 CandidateRun outcome 或旧成功报告。

验收：停止超时、workspace release 失败、候选进程崩溃和报告失败分别可重放。

## P2：Recovery 逻辑复杂度和职责重叠

### 现状

`src/application/recovery/` 文件较多，包含 run、orchestrator、forensics、evaluation、checkpoint、readiness、verifier、fail 等多个层次。需要确认 `RecoveryAgent` 的自然语言判断没有被确定性 verifier 重复或反向覆盖。

### 规划

固定流水线：

```text
读取 observations → Agent 调查/恢复 → 写 recovery.md
→ Schema/路径/污染/必要条件检查 → CandidateLaunchContext
```

机械 verifier 只能拒绝不安全或不完整结果，不能替 Agent 补造观察事实；fallback 必须沿用既有 decision records 的语义，并在 TUI/Comparison 中显示限制。

验收：Agent 报告 ready 但 staging 不满足条件时不能启动；Agent blocked 时不能由 Application 强行放行。

## P2：Claude Code/Codex 重复代码

`jscpd` 报告两套 Pack 的 sessions、runtime、runner 存在重复。建议抽取仅限于：进程生命周期、Windows 启动、超时、停止、Session 文件安全读取、通用错误分类和事件 Envelope 写入。不得抽取产品协议解析、原生 turn settlement 细节或 UserSurfaceProjection。

验收：抽取共享层后两个 Pack 的产品行为测试仍独立覆盖；共享层不出现 `productId` 分支。

## P2：Environment 与 ProductRuntime 资源所有权

需要审查 workspace release、候选进程 stop、snapshot seal 和 artifact capture 的所有权是否只由 CandidateRun 触发一次。Runtime 不应释放 Environment，Environment 不应直接改变 CandidateRun 状态。

验收：每条终止路径只有一个 stop/release owner；重复 cleanup 幂等；remaining resources 和 cleanup unknown 可持久化。

## P2：TUI/CLI 是否仍存在状态复制

TUI 已改为消费新的 Runtime 事件，但需要继续审查 `controller-run.ts`、`timeline.ts`、`view-projection.ts` 和 CLI query 是否各自推导阶段状态。阶段状态应由 Application 事件或查询投影统一产生，UI 只格式化。

验收：TUI 与 CLI 对同一 ExperimentStore 给出一致阶段、失败来源、cleanup 和报告路径；UI 不读取活动 Runner。

## P2：Schema/持久化版本覆盖

新增 Candidate Runtime Journal、UserVisibleTurn、CandidateLaunchContext 和 Comparison 输入后，需要确认所有持久化对象均有 schemaVersion、读取未知版本 fail-closed、写出只使用当前版本、所有外部 JSON 经过 `Value.Check`。

验收：损坏 JSON、未知版本、错误 session/run 所有权、非法 evidence ref 和截断日志均有明确诊断；不得静默降级为成功。

## P3：重复与死代码清理

当前工作区仍有未跟踪 `audit-root/`、`unused/`，应确认是否为生成产物；非受控产物不得进入提交。删除旧模块后需用 `rg`、knip 和架构测试确认没有旧导入、旧状态字段、旧 Provider 名称或孤立文件。

## P3：文档一致性

检查以下文档是否只描述当前目标边界，不残留旧路径、旧事件名或与 accepted decisions 冲突的表述：

- `docs/architecture/controller.md`
- `docs/architecture/comparison.md`
- `docs/architecture/overview.md`
- `docs/architecture/product-plugin-compatibility.md`
- `docs/architecture/environment.md`
- `docs/product/tui.md`
- `docs/plan/*`
- `docs/progress/MASTER.md`

文档中的目标计划不能写成已上线行为；协议变化需同步对应 decision record。

## 推荐后续顺序

```text
1. Application 编排瘦身与统一收尾
2. Runtime Journal 单一写入边界
3. briefing 原子发布与回放检查
4. Comparison 封存输入生命周期
5. Recovery verifier/feedback 分层核对
6. TUI/CLI 查询投影统一
7. Claude/Codex 共享进程基础设施抽取
8. Schema/version/error-path 补齐
9. 删除死代码与清理生成物
10. 文档、ADR、progress 和完整验证
```

## 审查验收

每一项完成前至少运行：

```text
npm run build
npm run check
npm run verify:docs
```

涉及 UI 时还要运行 TUI 帧审计；涉及真实产品时只运行显式 opt-in smoke。完成声明必须附实际输出和未解决风险，不以单纯测试通过替代架构审查。
