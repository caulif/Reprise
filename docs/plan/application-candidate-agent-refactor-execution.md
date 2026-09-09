# Application 与受控候选 Agent 链全面重构执行指南

状态：proposed，供执行 Agent 按阶段实施。

## 1. 任务边界

Reprise 的 `AgentHost / AgentSession` 已负责 Controller、Recovery、Comparison 的模型运行，本计划不新增 Agent 底座，也不建立 Agent 间消息总线。重构范围是候选实验链及其入口：Core 协议、Product Pack、历史会话与 observations、Recovery 交接、候选 Runtime、CandidateRun、Application、Comparison 资料物化、TUI/CLI。

```text
TUI/CLI
  → Application Workflow
      ├→ HistoryReader → observations → RecoveryAgent → staging
      ├→ ControllerAgent ↔ CandidateRun → ProductRuntime → TargetRunner → 新候选 Session
      └→ sealed history + candidate materials → ComparisonAgent
```

整体重构不保留旧命名、兼容别名或双轨实现。Application 不执行候选工具、不读取隐藏推理、不替 Controller 生成消息、不替 Comparison 判断；产品私有协议不得泄漏到 Application。

## 2. 固定产品闭环

```text
配置 Reprise 模型 → 选择历史会话并冻结 TaskCase
→ HistoryReader 物化完整 observations
→ RecoveryAgent 恢复任务开始前等价条件
→ Host 机械准入校验
→ 选择候选产品/模型并启动隔离目录中的全新 Session
→ Controller opening send
→ CandidateRun 投递普通用户消息
→ 原生 turn settlement
→ Product UI Projection 生成 UserVisibleTurn
→ 持久化本轮材料
→ Controller steering send/done
→ 循环或终止
→ 停止、封存、释放
→ Comparison 读取历史与候选完整过程和结果
→ report.html
```

Controller 的 opening/steering 以 `docs/architecture/controller.md` 和源码为准；Comparison 的材料与四轮流程以 `docs/architecture/comparison.md` 为准。

## 3. 目标目录与模块责任

### 3.1 Core 协议、Schema 与持久化

目标文件：

```text
src/core/
├── schemas/{task-case,scene,run,recovery,event,ids}.ts
├── runtime.ts
├── state-machine.ts
├── evidence-refs.ts
├── paths.ts
├── json.ts
└── identity.ts
```

Core 只定义产品无关的数据、状态不变量、路径和证据规则。补充并校验 `ImportedSession`、`CandidateLaunchContext`、`CandidateSessionHandle`、`CandidateRuntimeEvent`、`UserVisibleTurn` 和 Comparison 引用。外部 JSON、持久化、模型输出和产品解析结果必须经过 `Value.Check`；CandidateRun 状态只能经 `assertTransition`。Core 不导入 Application、Product Pack、TUI 或具体 CLI。

验收：所有新类型有 Schema、序列化入口、所有权和证据引用规则；同一输入可确定性重建。

### 3.2 Product Pack 注册与合约

目标文件：

```text
src/products/
├── contract.ts
├── registry.ts
├── index.ts
├── pack-access.ts
└── packs/{claude-code,codex}/
```

每个 Pack 同时提供三个无共享可变状态的能力：

```ts
interface ProductPack {
  readonly manifest: ProductManifest;
  readonly history: ProductHistoryReader;
  readonly runtime: ProductRuntime;
}
```

`history` 负责本地会话发现与读取；`runtime` 负责可用性、模型目录、候选校验和新 Session；投影器属于 runtime 的产品实现。Registry 统一查找，未知产品返回结构化错误；Application 只依赖合约。用户本地凭据/登录状态直接使用，任何凭据不落盘。

验收：Fake Pack 可完成发现、读取、列模型、解析候选和创建 Runner；无 Application 产品类型分支。

### 3.3 HistoryReader、ImportedSession 与 observations

目标文件：

```text
src/products/history/
├── types.ts
├── discover.ts
├── read.ts
├── normalize.ts
├── source-refs.ts
└── observations-materializer.ts
```

`ImportedSession` 保留上层需要的完整材料：用户/Agent/工具消息顺序、附件、事件、产物、项目路径、时间、元数据和来源引用。无法解析的记录保留脱敏原文或引用并标记 `unreadable`。Host 以稳定排序、原子写入生成：

```text
observations/{INDEX.md,session.json,user-inputs/,transcript/,events/,artifacts/,files/,metadata/,source-refs/}
```

Recovery、TUI、CLI、Comparison 只读物化材料；禁止执行历史内容、泄露产品原始路径或把历史 Agent 输出标成用户知识。凭据、环境变量秘密和越权文件不得物化。

验收：重复物化字节稳定；全部历史用户输入可按索引读取；过程、结果、附件和缺失标记可供 Comparison 调查。

### 3.4 Recovery 与 Environment

目标文件：

```text
src/application/recovery/{recover,input,admission,launch-context,staging,types}.ts
src/environment/{local-workspace-provider,local-workspace-fs,contamination,snapshots}.ts
```

RecoveryAgent 只读 observations 和 staging，恢复任务开始前的等价条件。项目文件、工作目录、依赖、配置和任务资源必须恢复；后继产物、临时文件和过程日志默认清除；Git 历史、缓存和非关键配置按需保留。Host 校验 `recovery.md`、结果 Schema、隔离路径、污染、必要输入和可读性。成功后生成不可变：

```ts
type CandidateLaunchContext = {
  experimentId: string; runId: string; workspaceRoot: string;
  productId: string; requestedModel: string; resolvedModel: string;
  permissions: Record<string, string>;
};
```

准入失败不创建 CandidateRun；原始项目始终不变。

### 3.5 候选 Runtime、TargetRunner 与产品 Adapter

目标文件：

```text
src/core/runtime.ts
src/products/packs/<product>/{runtime,runner,protocol,projection}.ts
src/infrastructure/process/{spawn,terminate,stdio}.ts
```

Runner 在 launch context 的 workspace 中启动全新 Session，保存真实：

```ts
type CandidateSessionHandle = {
  sessionId: string; productId: string; requestedModel: string;
  resolvedModel: string; workspaceRoot: string;
};
```

`start/send` 只投递普通用户消息并返回 delivery；`waitForTurn` 只在产品原生 settlement 后返回；提供取消等待、inspect、stop 和失败分类。Session 失效、进程重启或 unknown delivery 均为候选失败，不换 Session 继续。CLI/IPC/API、参数和协议全部封装在 Pack；Windows `.cmd`、路径、进程终止遵循项目规范。

验收：Fake Runner 覆盖 accepted/rejected/unknown、completed/waiting/failed/aborted、超时、取消、迟到事件、stop 和 cleanup；真实产品只走显式 opt-in smoke。

### 3.6 标准 Runtime 事件与 UserSurfaceProjection

目标文件：

```text
src/core/runtime.ts
src/products/packs/<product>/projection.ts
src/application/candidate-run-events.ts
```

Adapter 将原始消息转换为：

```ts
type CandidateRuntimeEvent = {
  eventId: string; sequence: number; type: CandidateRuntimeEventType;
  occurredAt: string; sessionId: string; turnId?: string;
  messageId?: string; callId?: string; payload: unknown;
  evidenceRefs: readonly string[];
};
```

事件类型覆盖 Session、消息投递、turn、工具摘要、可见输出/提示、用量、失败、停止和关闭。影响状态、Controller 视图、Comparison 判断、清理或审计复原的事件进入 Journal；原始包体、心跳、内部重试、未稳定 token、私有 UI 树和凭据只在 Adapter 内部保留。

每个 Pack 的 Projection 消费标准事件，只在 settlement 后生成 `UserVisibleTurn`（公开助手文本、状态、确认/授权/拒绝提示、交付入口和观察时间）。写入不可变：

```text
controller-briefing/current-user-view.md
controller-briefing/run/turns/{n}/user-view.md
```

视图失败不能静默为空；流式中间内容、隐藏推理和内部诊断不得进入视图。

### 3.7 CandidateRun

目标文件：

```text
src/application/candidate-run.ts
src/application/candidate-run-events.ts
src/application/candidate-run-cleanup.ts
src/application/candidate-run-facts.ts
```

CandidateRun 是候选状态、幂等、事实、清理和结果的唯一边界。绑定 run/session/turn/message 所有权；同 Session 严格串行；`send` 仅映射 start/submit，`done` 仅映射 settleController；`clientMessageId` 幂等，unknown delivery 不重发；所有迁移经 `assertTransition`。

固定顺序：`controller.decision → input.submitted → delivery_observed → turn_settled → user-view → controller.requested`。`waiting_input` 回到 awaiting_controller；候选 failed/aborted 立即终止。终止统一 stop → artifact capture → environment release → outcome，终态不可覆盖。

验收：并发 submit、重复消息、取消竞态、超时、迟到 settlement、stop/release 超时和 artifact capture 失败都有确定结果。

### 3.8 Controller 编排

目标文件：

```text
src/application/controller-briefing.ts
src/application/controller-request.ts
src/application/controller-queries.ts
src/application/experiment.ts
```

只组装稳定上下文、记录 decision/requested、调用 ControllerAgent，并把 `send/done` 交给 CandidateRun。首轮沿用 Controller 设计：同一 Session 先自由理解，再返回 opening send；Application 不发送 initialInput。steering 只能发生在 settlement 与用户视图持久化后。Briefing 不复制 Controller 规则引擎。

### 3.9 Application Workflow、活动控制与持久化

目标文件：

```text
src/application/experiment-workflow.ts
src/application/experiment-operations.ts
src/application/experiment-preflight.ts
src/application/experiment-activity.ts
src/application/experiment-control-host.ts
src/application/experiment-queries.ts
```

Workflow 是唯一跨模块编排入口：配置、intake、Recovery、候选选择、启动、Controller 循环、清理、Comparison。Operations 只调用端口，Queries 只读持久化，Control Host 只处理认证 IPC 和取消。每个活动有 experiment/run ID 和 AbortSignal。Application 不执行候选工具、不解析私有协议、不绕过 CandidateRun。

### 3.10 Comparison 资料物化与发布

目标文件：

```text
src/application/comparison.ts
src/application/comparison-briefing.ts
src/application/experiment-compare-persisted.ts
src/application/experiment-report.ts
src/agents/comparison-agent.ts
```

CandidateRun 停止、封存和释放后生成：

```text
comparison-attempt/{INDEX.md,facts/,history/,candidate/,work/}
```

`history/` 和 `candidate/` 保留各自真实的消息、事件、视图、产物、变更和 outcome，不强行统一结构。ComparisonAgent 按索引按需读取，不访问活动 Session、不修改事实；复用既有四轮 Session/Publisher。候选失败但材料存在时允许比较，材料未形成时不启动；报告失败不覆盖候选结果和旧成功报告。

### 3.11 TUI

目标文件：

```text
src/tui/{controller-input,controller-run,workbench,view-projection,timeline,types,widgets,theme,i18n}.ts
```

TUI 只投影 Application/持久化事件，保存选择状态和活动句柄，不保存实验事实，不访问 Runner。状态为配置 → Intake → Recovery → 候选产品/模型 → 启动确认 → Controller/Candidate → 终态 → Comparison。展示 experimentId、runId、sessionId、产品/模型、用户视图、失败来源、cleanup 和报告路径。取消只调用活动控制端口；路径由 Application 返回；不解析 HTML、不读取隐藏推理。更新文案、帮助和帧基线。

### 3.12 CLI/Headless

目标文件：

```text
src/cli/{main,headless,query,protocol,sessions-dirs}.ts
```

CLI 与 TUI 共用 Workflow 和查询投影。命令只解析参数、校验 Schema、调用 Application、输出产品无关状态和退出码；`prepare/run/compare/cancel` 不复制编排；products/models/history/config 不读私有格式。输出不得含凭据、原始协议包体、隐藏模型文本或敏感诊断。

### 3.13 测试、文档和工程门禁

目标目录：

```text
test/{core,products,application,candidate,tui,cli}/
docs/architecture/
docs/decisions/
docs/plan/
docs/progress/
```

先用 Fake Pack/Runner/Projection 覆盖端口与状态不变量，再覆盖完整闭环，最后才做显式 opt-in 产品 smoke。协议、持久化、工具面和门禁变化同批更新 ADR；目标写 plan，实际证据写 progress。代码改动按仓库要求先 `npm run build` 再 `npm run check`；文档改动运行 `npm run verify:docs`。

## 4. 实施顺序与阶段交付

```text
0 基线/不变量
→ 1 Core 与 ProductPack 合约
→ 2 History/observations
→ 3 Recovery 准入
→ 4 Runtime/TargetRunner
→ 5 标准事件/Projection
→ 6 CandidateRun
→ 7 Application/Controller 编排
→ 8 Comparison 物化
→ 9 TUI/CLI
→ 10 删除旧代码、文档同步、最终验证
```

每阶段必须交付：修改文件清单、删除的旧接口、相关测试、实际验证输出和未解决问题。下游不得自行发明上游未冻结的字段；上游协议变化必须重新检查全部读写者。

## 5. 统一验收

- 一个 TaskCase 只创建一个 CandidateRun，候选始终在隔离目录启动新 Session。
- Controller 是唯一候选消息来源；每轮输入、settlement、用户视图和下一次请求可复原。
- 历史与候选完整过程和结果可供 Comparison 按需读取。
- 候选失败、Reprise Agent 失败、Application 失败和取消边界清晰，终止都执行停止、封存、释放和 outcome。
- TUI/CLI 只调用 Application，且对同一持久化事实展示一致。
- 产品私有协议、凭据、隐藏推理不泄漏到上层。
- 构建、门禁、相关测试和文档校验都有新鲜证据。

## 6. 冲突检查

每阶段结束检查：Reprise AgentHost 是否仍只服务内部 Agent；ProductPack 是否同时提供 history/runtime/projection；Recovery 是否只读受控 observations；候选是否始终新 Session；CandidateRun 是否唯一状态/清理边界；事件、视图和 Comparison 材料是否可复原；TUI/CLI 是否只调用 Application；是否引入产品分支、重复事实源、绕过状态机、并行候选、Agent 消息总线或旧兼容路径。
