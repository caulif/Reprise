# 架构设计深度分析：理论、模式与实现

状态：研究备忘 v1.1
日期：2026-08-07

定位：本文用于保存理论背景、备选方案和反面案例；[架构总览](../architecture/overview.md)是产品架构与实现边界的唯一主设计。本文中的示例接口和演进建议不能覆盖主设计。

---

## 摘要

本文档基于软件架构理论、Agent Harness 架构研究和 Pi Agent 的设计哲学，审查 Reprise 的架构选择。核心结论是：**保持薄而完整的编排内核，通过端口隔离外部变化，并把会话环境恢复和同等人类能力作为两个不可删除的产品能力**。模型是比较变量；候选使用当前已安装 Agent Runtime 并自动记录其事实，任务环境则尽量恢复。

---

## 1. 架构理论基础

### 1.1 Hexagonal Architecture：端口与适配器

[Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)（也称 Ports and Adapters）的核心思想是：**应用的业务逻辑定义它需要什么（Ports），外部世界适配过来提供（Adapters）**。

**核心原则**：
- **依赖倒置**：不是核心依赖外部（数据库、UI、API），而是外部依赖核心定义的接口
- **技术无关**：核心不知道使用的是 Postgres 还是 MongoDB，是 REST 还是 GraphQL
- **可测试性**：核心可以在没有真实外部依赖的情况下测试

**在 Harness 中的应用**：

```text
Harness Core（六边形的中心）
    ↓ 定义端口
RuntimePort / EnvironmentPort / AgentServicesPort / TracePort
    ↓ 适配器实现
ClaudeCodeAdapter / GitEnvironment / PiController / JsonlTrace
```

**关键洞察**：
- Core 不知道 Claude Code、Codex、Cursor 的存在
- Core 只知道"我需要一个能启动 Agent、发送消息、获取 turn 边界的 Runtime"
- 具体产品的协议、版本、事件格式都在 Adapter 中处理

---

### 1.2 Anti-Corruption Layer：防止外部模型污染

[Domain-Driven Design 中的 Anti-Corruption Layer](https://docs.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer) 是一个**防御性边界，防止外部系统的概念泄漏到你的领域模型中**。

**核心问题**：
- Claude Code 有自己的事件格式、术语、协议
- Codex 有不同的事件格式、术语、协议
- 如果 Core 直接依赖这些产品特有的模型，每次新增产品都要修改 Core

**ACL 的作用**：
```text
Claude Code 原生事件 → ClaudeCodeAdapter 翻译 → 统一的 RunEvent
Codex 原生事件     → CodexAdapter 翻译     → 统一的 RunEvent
```

**在 Harness 中的应用**：

每个 Runtime Adapter 是一个 ACL：
- **输入翻译**：将统一的 `UserMessage` 翻译成产品特有的格式
- **输出翻译**：将产品特有的事件翻译成统一的 `RunEvent`
- **保留原始**：原始事件完整保存在 `raw/` 目录，不丢失信息

**关键决策**：
- Core 定义的是**实验语义**（turn、observation、decision）
- 不是 Claude Code 的语义（stream-json、turn.completed）
- 也不是 Codex 的语义（exec --json、JSONL）

---

### 1.3 Modular Monolith：有边界的单体

[Modular Monolith](https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer) 的核心思想是：**在单个部署单元内，通过强边界分离模块**。

**关键特征**：
- 每个模块有明确的职责
- 模块间通过定义的接口通信
- 模块内部实现对外部不可见
- 可以在单一进程中运行，也可以后续拆分

**与微服务的对比**：

| 维度 | Modular Monolith | Microservices |
|------|------------------|---------------|
| 部署 | 单一进程 | 多个独立进程 |
| 边界 | 编译时强制（接口） | 运行时强制（网络） |
| 复杂度 | 低 | 高（分布式系统） |
| 演进 | 可后续拆分 | 已经拆分 |

**在 Harness 中的应用**：

```text
reprise/
├── core/           # 核心模块：Orchestrator、端口定义
├── adapters/       # 适配器模块：Runtime、Environment 实现
├── controller/     # Controller 模块：基于 Pi 的实现
└── cli/            # CLI 模块：用户界面
```

**边界强制**：
- `core/` 不能导入 `adapters/` 的具体实现
- `adapters/` 可以导入 `core/` 的端口定义
- 通过依赖检查工具（如 `dependency-cruiser`）强制边界

**何时拆分**：
- 第一版：单一 monorepo，清晰模块边界
- 有第三方 adapter 需求时：提取 `core` 为独立包
- 永远不拆分：除非有明确的分布式需求

---

### 1.4 Append-Only Audit Log，而非完整 Event Sourcing

[Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) 的核心思想是：**应用状态不是存储为可变记录，而是存储为不可变事件的序列**。

**核心特征**：
- **Append-only**：事件一旦写入，永不修改或删除
- **事件即历史**：可以重放事件来重建任何时间点的状态
- **完整审计**：知道"什么时候发生了什么"，不只是"当前是什么"

**传统方式 vs Event Sourcing**：

```text
传统数据库：
UPDATE runs SET status='finished' WHERE id=123
# 丢失了：什么时候开始的？中间经历了什么？

Event Sourcing：
run_started    { run_id: 123, timestamp: ... }
turn_completed { run_id: 123, turn: 1, ... }
turn_completed { run_id: 123, turn: 2, ... }
run_finished   { run_id: 123, reason: "controller_done", ... }
# 完整历史，可重放，可调试
```

Harness 只采用其中的不可变事实记录，不预先承诺完整 Event Sourcing。控制外部 CLI、文件系统和网络副作用时，事件存在并不意味着动作可安全重放。

**在 Harness 中的应用**：

```text
runs/<run-id>/
├── events.jsonl    # 每行一个事件，永不修改
├── raw/            # 原始产品事件，完整保留
└── manifest.json   # 最终状态的快照
```

**好处**：
1. **可追溯**：任何问题都能回溯完整历史
2. **可调试**：按事件序列定位问题发生点
3. **有限恢复**：结合持久状态与事件判断可恢复范围，不自动重放外部副作用
4. **可审计**：证明"Controller 在第 5 轮介入，理由是 X"

**明确不做**：
- 不需要完整的 CQRS（Command Query Responsibility Segregation）
- 不需要分布式事件总线
- 不承诺仅靠 `replay(events)` 重建目标进程和外部环境
- 只要求 append-only trace、原始数据保留以及报告可重新生成

---

### 1.5 Capability-Based Security：能力即权限

[Capability-Based Security](https://en.wikipedia.org/wiki/Capability-based_security) 的核心思想是：**访问权限不是基于身份，而是基于持有的能力（capability）**。

**传统 ACL vs Capability**：

```text
传统 ACL（访问控制列表）：
"用户 Alice 可以访问文件 /home/bob/file.txt"
问题：如果 Alice 被攻击，攻击者获得所有 Alice 的权限

Capability：
"这个 handle 可以读取这个文件"
优势：只能访问显式传递的资源
```

**在 Harness 中的应用**：

Environment Provider 不是给予"完整文件系统访问权"，而是给予：
- 特定目录的 capability
- 特定 git 仓库的 capability
- 特定测试命令的 capability

```typescript
interface PreparedEnvironment {
  workDir: DirectoryCapability;     // 只能访问这个目录
  gitRepo?: GitCapability;          // 只能操作这个仓库
  allowedCommands: CommandCapability[];  // 只能运行这些命令
}
```

**关键好处**：
1. **最小权限原则**：只给需要的能力
2. **沙箱隔离**：一个实验不能访问另一个实验的目录
3. **可审计**：知道"谁在什么时候访问了什么"

**实现提示**：
- 不需要完整的对象能力系统（Object Capabilities）
- 只需要：每个 Provider 只接收它需要的路径/句柄
- TypeScript 的类型系统已经提供了一定程度的保护

---

### 1.6 Evolutionary Architecture：适应变化的架构

[Thoughtworks 的 Evolutionary Architecture](https://www.thoughtworks.com/insights/books/building-evolutionary-architectures) 提出：**架构不是一次性设计，而是持续演进的**。

**Fitness Functions**：
像生物进化的适应度函数，定义"好的架构"的度量标准，并自动化检查。

**在 Harness 中的应用**：

```typescript
// 架构适应度函数（可自动化测试）

// 依赖方向：Core 不依赖 Adapters
test('core should not import adapters', () => {
  const violations = checkDependencies('core', 'adapters');
  expect(violations).toEqual([]);
});

// 事件不可变：TraceStore 只允许 append
test('trace store should be append-only', () => {
  const store = new TraceStore();
  store.append(event1);
  expect(() => store.update(event1)).toThrow();
});

// 端口稳定性：RuntimePort 接口不频繁变化
test('RuntimePort should be stable', () => {
  const history = git.log('core/runtime-port.ts');
  const changes = history.filter(c => c.type === 'breaking');
  expect(changes.length).toBeLessThan(3); // 容忍少量演进
});
```

**关键原则**：
1. **有向进化**：通过 fitness functions 指导演进方向
2. **渐进式变化**：小步快跑，每步都可验证
3. **可逆决策**：优先选择容易回退的方案

**不腐化的架构**：
- 自动化检查边界（dependency-cruiser）
- 自动化检查不变量（事件不可变、append-only）
- 定期审查 fitness functions 本身

---

## 2. Pi Agent 的设计哲学

### 2.1 Pi Agent 的架构特征

[Pi Agent](https://github.com/earendil-works/pi) 的设计哲学是：**少量明确原语、事件流、组合优先、避免宏大框架**。

**核心特征**：

1. **分层架构，零依赖基础**
```text
pi-tui              # 终端 UI
    ↓
pi-coding-agent     # 完整 coding agent
    ↓
pi-agent-core       # agent 循环 + 工具调用
    ↓
pi-ai               # LLM 通信
```

每层只依赖下层，基础层零依赖。

2. **可编程平台，而非可配置产品**
- 25+ TypeScript hooks
- 热重载扩展
- 开发者控制 > 约定

3. **硬约束保证正确性**
- Edit 工具拒绝模糊匹配
- 要求 Agent 先读取文件状态
- 通过硬错误防止文件损坏

4. **最小 harness，最大信任**
- 给 Agent 一个 shell
- 信任它能处理后续任务
- 不强加 rigid patterns

**关键洞察**：
> "The framework is a programmable platform with 25+ in-process TypeScript hooks that let you build your own agent experience, rather than a configurable product with preset features."

---

### 2.2 应用 Pi 哲学到 Harness

**借鉴的原则**：

1. **少量明确原语**
```text
Harness 的原语：
- TaskCase：历史任务的快照
- Observation：当前状态的只读视图
- Decision：Controller 的输出
- Event：不可变的事实记录
- Capability：受限的访问权限
```

不是：大量的抽象类、工厂、策略模式。

2. **事件流驱动**
```text
Runtime 产生事件 → Orchestrator 订阅 → 决策 → 新事件
```

不是：轮询、回调地狱、复杂状态机。

3. **组合优先**
```text
Orchestrator = 状态机
              + RuntimeAdapter（可替换）
              + EnvironmentProvider（可替换）
              + Controller（可替换）
              + TraceStore（可替换）
```

每个组件可独立测试、独立替换。

4. **开发者控制**
- 不强制特定的 Runtime 实现方式
- 不强制特定的 Environment 恢复策略
- 不强制特定的 Controller 模型
- 提供端口，由开发者决定实现

**不同之处**：

| Pi Agent | Harness |
|----------|---------|
| 执行 Agent | 测试 Agent |
| 用户直接使用 | 用户评估对比 |
| 需要灵活性 | 需要可比性 |
| 信任 Agent | 观察 Agent |

Harness 需要更强的**观察性**和**可追溯性**，因为目标是评估，不是执行。

---

## 3. Agent Harness 架构研究

### 3.1 Agent Harness 的定义

根据研究，[Agent Harness 是将 LLM 转变为功能性 Agent 的基础设施层](https://www.anthropic.com/research/harness-engineering)：

**核心组件**：
- 执行循环（Execution Loop）
- 工具调用（Tool Calls）
- 上下文管理（Context Management）
- 内存（Memory）
- 护栏（Guardrails）
- 追踪（Tracing）

**对 Harness 的启示**：
- 我们测试的不只是模型，还包括 Runtime（harness）
- Runtime 的版本、配置、工具策略会显著影响结果
- 不恢复历史 Runtime；同一 Experiment 应记录当前 Runtime，并检测候选执行期间的意外漂移

这里不把未经本文核验的单一成功率数字作为架构依据。对本产品更准确的表述是：用户观察到的是“模型在特定 Runtime 与环境中的实际效果”；模型是比较变量，Runtime 和环境是控制条件，而不是把结果解释成脱离产品的基础模型分数。

---

### 3.2 插件架构模式

研究了多个 Agent 框架的插件系统：

#### Harbor/Harness.io 模式
- 每个插件是独立的容器
- 通过环境变量传递配置
- 插件注册在中央目录

**优点**：隔离性强，语言无关
**缺点**：启动开销大，通信复杂

#### OSGi 模式
- Bundle 生命周期管理
- Service Registry（服务注册表）
- 显式依赖声明

**优点**：成熟的模块化系统
**缺点**：Java 专用，复杂度高

#### 简单插件模式（推荐用于 Harness）
```typescript
interface RuntimePlugin {
  name: string;
  version: string;

  // 发现能力
  canHandle(source: SessionSource): boolean;

  // 核心能力
  createRunner(context: RunContext): TargetRunner;
}

// 注册
registry.register(new ClaudeCodePlugin());
registry.register(new CodexPlugin());
```

**优点**：简单、类型安全、零开销
**缺点**：需要重启才能加载新插件（第一版可接受）

---

## 4. 精炼的架构模型

### 4.1 两个稳定的关注点分离

基于理论和 Pi 哲学，Harness 的核心应该只关注两件事：

#### 关注点 1：会话环境恢复（Environment Recovery）

**职责**：
- 从历史会话中提取环境证据
- 恢复任务开始时的状态
- 提供隔离的运行环境
- 清理和验证

**边界**：
- 确定性操作（inspect、prepare、fingerprint、cleanup）
- 不做概率性推理（可以用 Agent 辅助规划，但执行必须确定）

**可插拔性**：
```text
EnvironmentProvider
├── GitEnvironment       # git commit + worktree
├── FileSystemEnvironment  # copy 目录
├── BrowserEnvironment   # profile 副本（未来）
└── CustomEnvironment    # 用户自定义
```

---

#### 关注点 2：同等人类能力（Controller）

**职责**：
- 观察当前 Agent 状态
- 决定是否需要用户介入
- 生成用户会给出的消息
- 决定何时结束

**边界**：
- 只读观察，不执行
- 基于能力边界，不是通用模拟器
- 输出结构化决策（wait/send/done）

**实现方式**：
```text
AgentServicesPort.nextUserMessage
└── Pi Agent Services    # 正式实现；测试使用普通 fake/stub
```

---

### 4.2 薄的编排层（Orchestrator）

Orchestrator 是整个系统的"脊柱"，但应该保持**极简**：

**唯一职责**：协调生命周期

```typescript
class ExperimentOrchestrator {
  async run(taskCase: TaskCase, config: RunConfig): Promise<RunResult> {
    // 1. 准备环境
    const env = await environmentProvider.prepare(taskCase);

    // 2. 启动 Runtime
    const runner = await runtimePlugin.createRunner(env);
    await runner.start(taskCase.initialMessage);

    // 3. 协作循环
    while (true) {
      const observation = await runner.waitForTurn();
      trace.append({ type: 'observation', data: observation });

      const decision = await controller.decide(observation);
      trace.append({ type: 'decision', data: decision });

      if (decision.type === 'done') break;
      if (decision.type === 'send') {
        await runner.send(decision.message);
      }
    }

    // 4. 清理
    await env.cleanup();
    return trace.summarize();
  }
}
```

**不做的事**：
- ✗ 解析产品协议（在 Adapter 中）
- ✗ 生成用户消息（在 Controller 中）
- ✗ 恢复环境状态（在 Provider 中）
- ✗ 格式化报告（在 Reporter 中）

**只做的事**：
- ✓ 七状态生命周期转换与停止原因
- ✓ 预算检查（时间、turn、成本）
- ✓ 事件记录（append-only）
- ✓ 错误处理（超时、失败、中止）

---

### 4.3 清晰的端口定义

基于 Hexagonal Architecture，定义四个核心端口：

#### RuntimePort：Target Agent 的抽象

```typescript
interface RuntimePort {
  // 发现：找到本机的历史会话
  discoverSessions(source?: SessionSource): Promise<SessionRef[]>;

  // 检查：提取会话的元信息
  inspectSession(ref: SessionRef): Promise<SourceRuntimeEvidence>;

  // 创建：实例化一个 Runner
  createRunner(context: RunContext): Promise<TargetRunner>;
}

type SendReceipt = {
  delivery: "accepted" | "rejected" | "unknown";
  turnId?: string;
  messageId?: string;
  acceptedAt?: string;
  evidence: "preflight" | "rpc_response" | "native_admission" | "persisted" | "native_event";
};

interface TargetRunner {
  // accepted 仅表示输入进入 Runtime 控制边界，不表示 turn 已完成
  start(message: UserMessage): Promise<StartReceipt>;

  // 发送：发送后续消息
  send(message: UserMessage): Promise<SendReceipt>;

  // 等待：等待 turn 完成
  waitForTurn(options?: WaitOptions): Promise<TurnSettlement>;

  // 订阅：监听原始事件
  onEvent(handler: (event: RawEvent) => void): Unsubscribe;

  // 停止：终止运行
  stop(reason: StopReason): Promise<void>;
}
```

**关键设计**：
- `discoverSessions` 和 `inspectSession` 分离：发现是轻量的，检查是重的
- `waitForTurn` 是阻塞的：Orchestrator 不需要处理复杂的异步事件
- `onEvent` 提供原始事件：用于调试和完整追踪

---

#### EnvironmentPort：环境管理的抽象

```typescript
interface EnvironmentPort {
  // 检查：提取环境证据
  inspect(source: EnvironmentSource): Promise<EnvironmentEvidence>;

  // 准备：创建隔离环境
  prepare(plan: RecoveryPlan, policy: RecoveryPolicy): Promise<PreparedEnvironment>;

  // 指纹：记录环境状态
  fingerprint(env: PreparedEnvironment): Promise<EnvironmentFingerprint>;

  // 清理：移除隔离环境
  cleanup(env: PreparedEnvironment, policy: CleanupPolicy): Promise<CleanupResult>;
}

interface PreparedEnvironment {
  workDir: string;                    // 工作目录
  capabilities: Capability[];         // 允许的操作
  evidence: EnvironmentEvidence;      // 恢复依据
  isolationMode: 'none' | 'copy' | 'checkpoint';  // 隔离方式
}
```

**关键设计**：
- `prepare` 接收计划而非自动推理：确定性优先
- `fingerprint` 在前后调用：可对比环境变化
- `capabilities` 明确权限边界：遵循最小权限原则

---

#### AgentServicesPort：用户协作能力的抽象

```typescript
interface AgentServicesPort {
  // 此处只展示运行循环使用的方法；恢复规划和报告选择见主设计。
  nextUserMessage(context: SteeringContext): Promise<ControllerDecision>;
}

interface SteeringContext {
  taskCase: TaskCase;                 // 原始任务
  observation: Observation;           // 当前状态
  priorDecisions: ControllerDecision[]; // 历史决策
  budget: RunBudget;                  // 剩余预算
}

type ControllerDecision =
  | { type: "send"; message: string }
  | { type: "done"; reason: string };
```

**关键设计**：
- 运行循环只需要 `nextUserMessage`，输入是只读上下文，输出是决策
- 输出只允许 `send(message)` 或 `done(reason)`，不预设 inform/correct/verify 等人类意图分类
- Agent Services 不能直接改变实验状态或环境

---

#### TracePort：事件存储的抽象

```typescript
interface TracePort {
  // 追加：写入新事件
  append(event: TraceEvent): Promise<void>;

  // 读取：获取所有事件
  read(filter?: EventFilter): Promise<TraceEvent[]>;

  // 快照：获取当前状态摘要
  snapshot(): Promise<RunSnapshot>;
}

interface TraceEvent {
  eventId: string;
  runId: string;
  timestamp: string;
  phase: Phase;
  type: string;
  data: unknown;
  rawRef?: string;  // 指向 raw/ 目录的原始事件
}
```

**关键设计**：
- Append-only：只有 `append`，没有 `update` 或 `delete`
- 原始引用：`rawRef` 保留产品特有事件的完整性
- 轻量快照：`snapshot()` 用于生成报告，避免重放全部事件

---

### 4.4 模块边界与依赖方向

**依赖规则**（从理论到实践）：

```text
                CLI / Reporter
                      ↓
                 Orchestrator
                ↙   ↓   ↓   ↘
          Runtime  Env  Ctrl  Trace
            Port   Port  Port  Port
             ↓      ↓     ↓     ↓
          Claude  Git   Pi   Jsonl
          Code   Env   Ctrl  Store
          Adapter
```

**严格规则**：
1. **Core 不依赖 Adapters**：`core/` 不能 import `adapters/` 的任何实现
2. **Adapters 可依赖 Ports**：适配器实现 Core 定义的接口
3. **单向依赖**：依赖只能指向更稳定的层

**如何强制**：

使用 `dependency-cruiser` 定义规则：
```javascript
// .dependency-cruiser.js
module.exports = {
  forbidden: [
    {
      name: 'core-no-adapters',
      from: { path: '^src/core' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'no-circular',
      from: {},
      to: { circular: true },
    },
  ],
};
```

**测试验证**：
```typescript
test('architecture boundaries', () => {
  const violations = checkDependencies();
  expect(violations).toEqual([]);
});
```

---

### 4.5 代码组织（实际目录结构）

**第一版推荐结构**：

```text
reprise/
├── src/
│   ├── core/
│   │   ├── orchestrator.ts       # 实验编排器
│   │   ├── ports/
│   │   │   ├── runtime.ts        # RuntimePort 定义
│   │   │   ├── environment.ts    # EnvironmentPort 定义
│   │   │   ├── agent-services.ts # AgentServicesPort 定义
│   │   │   └── trace.ts          # TracePort 定义
│   │   ├── types.ts              # 共享类型（TaskCase、Observation 等）
│   │   └── budget.ts             # 预算管理
│   │
│   ├── adapters/
│   │   ├── runtime/
│   │   │   ├── claude-code.ts    # Claude Code 适配器
│   │   │   └── codex.ts          # Codex 适配器（未来）
│   │   ├── environment/
│   │   │   ├── git-env.ts        # Git 环境提供者
│   │   │   └── fs-env.ts         # 文件系统提供者
│   │   ├── controller/
│   │   │   ├── pi-controller.ts  # 基于 Pi 的 Controller
│   │   │   └── replay.ts         # 重放 Controller（基线）
│   │   └── trace/
│   │       └── jsonl-store.ts    # JSONL 事件存储
│   │
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── run.ts            # harness run
│   │   │   ├── list.ts           # harness list
│   │   │   └── report.ts         # harness report
│   │   └── index.ts
│   │
│   └── reporter/
│       ├── markdown.ts           # Markdown 报告
│       └── html.ts               # HTML 报告（未来）
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── package.json
└── tsconfig.json
```

**关键原则**：
- `core/` 是稳定的，很少修改
- `adapters/` 是易变的，频繁扩展
- `cli/` 和 `reporter/` 是 UI 层，可独立演进
- 测试按类型分离：单元、集成、端到端

---

## 5. 插件系统设计

### 5.1 简单而有效的插件模式

基于 Pi 的哲学和研究的插件系统，推荐**轻量级插件注册模式**：

#### 插件接口

```typescript
interface Plugin<T> {
  name: string;
  version: string;
  capabilities: PluginCapabilities;
}

// Runtime Plugin
interface RuntimePlugin extends Plugin<TargetRunner> {
  // 能否处理这个会话源？
  canHandle(source: SessionSource): boolean;

  // 创建 Runner
  createRunner(context: RunContext): Promise<TargetRunner>;
}

// Environment Plugin
interface EnvironmentPlugin extends Plugin<PreparedEnvironment> {
  // 能否恢复这个环境？
  canRecover(evidence: EnvironmentEvidence): boolean;

  // 准备环境
  prepare(plan: RecoveryPlan, policy: RecoveryPolicy): Promise<PreparedEnvironment>;
}
```

---

#### 插件注册表

```typescript
class PluginRegistry<T> {
  private plugins: Map<string, Plugin<T>> = new Map();

  register(plugin: Plugin<T>): void {
    // 检查版本冲突
    const existing = this.plugins.get(plugin.name);
    if (existing && existing.version !== plugin.version) {
      console.warn(`Replacing ${plugin.name} ${existing.version} with ${plugin.version}`);
    }

    this.plugins.set(plugin.name, plugin);
  }

  select(predicate: (plugin: Plugin<T>) => boolean): Plugin<T> | undefined {
    for (const plugin of this.plugins.values()) {
      if (predicate(plugin)) return plugin;
    }
    return undefined;
  }
}
```

---

#### 使用示例

```typescript
// 在 main.ts 中注册插件
const runtimeRegistry = new PluginRegistry<TargetRunner>();
runtimeRegistry.register(new ClaudeCodePlugin());
runtimeRegistry.register(new CodexPlugin());  // 未来

const envRegistry = new PluginRegistry<PreparedEnvironment>();
envRegistry.register(new GitEnvironmentPlugin());
envRegistry.register(new FileSystemPlugin());

// Orchestrator 使用插件
const runtimePlugin = runtimeRegistry.select(p =>
  p.canHandle(taskCase.source)
);

if (!runtimePlugin) {
  throw new Error(`No plugin can handle ${taskCase.source.type}`);
}

const runner = await runtimePlugin.createRunner(context);
```

**优点**：
- ✓ 简单：不需要复杂的依赖注入容器
- ✓ 类型安全：TypeScript 编译时检查
- ✓ 可测试：契约测试保证插件质量
- ✓ 零开销：直接函数调用，无序列化

**缺点**：
- ✗ 需要重启才能加载新插件（第一版可接受）
- ✗ 不支持动态卸载（第一版不需要）

---

### 5.2 契约测试（Contract Tests）

每个插件必须通过由项目测试套件提供的最小契约测试。契约测试不属于生产插件接口，也不在用户每次启动 Harness 时运行：

```typescript
describe('ClaudeCodePlugin runtime contract', () => {
  test('starts, settles a turn, and preserves raw events', async () => {
    const events = [];
    const runner = await claudeCodePlugin.createRunner(mockContext);
    runner.onEvent(event => events.push(event));
    await runner.start({ content: 'echo hello' });
    const settlement = await runner.waitForTurn();

    assert(settlement.status === 'completed');
    assert(events.length > 0);
    assert(events.some(event => event.raw !== undefined));
  });
});
```

**契约测试保证**：
- 插件实现了最小接口
- 插件能正常工作（不是空壳）
- 插件保留原始事件（可追溯性）

---

### 5.3 插件发现与加载

**第一版：静态注册**

```typescript
// src/plugins/index.ts
import { ClaudeCodePlugin } from '../adapters/runtime/claude-code';
import { GitEnvironmentPlugin } from '../adapters/environment/git-env';
import { PiControllerPlugin } from '../adapters/controller/pi-controller';

export function loadPlugins() {
  const runtime = new PluginRegistry<TargetRunner>();
  runtime.register(new ClaudeCodePlugin());

  const environment = new PluginRegistry<PreparedEnvironment>();
  environment.register(new GitEnvironmentPlugin());

  const controller = new PluginRegistry<Controller>();
  controller.register(new PiControllerPlugin());

  return { runtime, environment, controller };
}
```

**未来：动态发现**（仅当有第三方插件需求时）

```typescript
// 扫描 ~/.reprise/plugins/ 目录
const pluginDirs = fs.readdirSync(pluginDir);
for (const dir of pluginDirs) {
  const manifest = require(path.join(dir, 'package.json'));
  if (manifest.harness?.plugin) {
    const Plugin = require(path.join(dir, manifest.main));
    registry.register(new Plugin());
  }
}
```

**不在第一版做**：
- ✗ npm 包形式的插件
- ✗ 插件市场
- ✗ 插件沙箱
- ✗ 插件依赖管理

---

## 6. 防止架构腐化

### 6.1 腐化的来源

基于 Evolutionary Architecture 的研究，架构腐化主要来自：

1. **依赖方向反转**：Adapter 开始被 Core 依赖
2. **边界泄漏**：产品特有概念进入 Core
3. **职责混乱**：Orchestrator 开始做 Controller 的事
4. **状态泄漏**：可变状态被多个组件共享
5. **隐式耦合**：通过全局变量或单例通信

**特别是被 Coding Agent 开发时**：
- Agent 可能不理解架构边界
- Agent 可能为了"方便"添加快捷方式
- Agent 可能复制粘贴代码而不抽象

---

### 6.2 Fitness Functions：自动化架构守护

#### Fitness Function 1：依赖方向

```typescript
// tests/architecture/dependencies.test.ts
import { checkDependencies } from 'dependency-cruiser';

describe('Architecture: Dependencies', () => {
  test('core should not depend on adapters', () => {
    const result = checkDependencies({
      from: 'src/core',
      to: 'src/adapters',
    });

    expect(result.violations).toEqual([]);
  });

  test('no circular dependencies', () => {
    const result = checkDependencies({
      circular: true,
    });

    expect(result.violations).toEqual([]);
  });
});
```

---

#### Fitness Function 2：接口稳定性

```typescript
describe('Architecture: Port Stability', () => {
  test('RuntimePort has not changed', () => {
    const current = extractInterface('src/core/ports/runtime.ts');
    const baseline = loadBaseline('RuntimePort');

    // 允许新增方法，但不允许修改现有签名
    expect(current.methods).toContainAll(baseline.methods);
  });
});
```

---

#### Fitness Function 3：事件不可变

```typescript
describe('Architecture: Immutability', () => {
  test('TraceStore is append-only', () => {
    const store = new TraceStore();
    const event = { type: 'test', data: {} };

    store.append(event);

    // 应该没有 update 或 delete 方法
    expect(store.update).toBeUndefined();
    expect(store.delete).toBeUndefined();

    // 事件不能被修改
    expect(() => {
      event.data.modified = true;
    }).toThrow(); // 如果使用 Object.freeze
  });
});
```

---

#### Fitness Function 4：命名约定

```typescript
describe('Architecture: Naming', () => {
  test('ports are named *Port', () => {
    const files = glob.sync('src/core/ports/*.ts');

    for (const file of files) {
      const name = path.basename(file, '.ts');
      const interfaces = extractInterfaces(file);

      for (const iface of interfaces) {
        if (iface.isPort) {
          expect(iface.name).toMatch(/Port$/);
        }
      }
    }
  });

  test('adapters are named *Adapter or *Plugin', () => {
    const files = glob.sync('src/adapters/**/*.ts');

    for (const file of files) {
      const classes = extractClasses(file);

      for (const cls of classes) {
        if (cls.implementsPort) {
          expect(cls.name).toMatch(/(Adapter|Plugin)$/);
        }
      }
    }
  });
});
```

---

#### Fitness Function 5：模块大小

```typescript
describe('Architecture: Module Size', () => {
  test('no file exceeds 300 lines', () => {
    const files = glob.sync('src/**/*.ts');

    for (const file of files) {
      const lines = countLines(file);
      expect(lines).toBeLessThan(300);
    }
  });

  test('core has fewer than 10 files', () => {
    const files = glob.sync('src/core/**/*.ts');
    expect(files.length).toBeLessThan(10);
  });
});
```

---

### 6.3 Code Review Checklist

**人工 Review 时检查**：

#### 新增 Adapter 时
- [ ] 是否实现了完整的 Port 接口？
- [ ] 是否通过了契约测试？
- [ ] 是否保留了原始事件到 `raw/`？
- [ ] 是否避免了产品特有概念泄漏到 Core？

#### 修改 Core 时
- [ ] 是否引入了对 Adapter 的依赖？（不允许）
- [ ] 是否修改了已有的 Port 接口？（需要充分理由）
- [ ] 是否增加了 Orchestrator 的职责？（应该在 Plugin 中）

#### 修改 Port 时
- [ ] 是否是 Breaking Change？（需要更新所有 Adapter）
- [ ] 是否有 Migration Guide？
- [ ] 是否更新了契约测试？

#### 新增依赖时
- [ ] 依赖放在哪个层？（Core 应该零依赖）
- [ ] 是否有更轻量的替代方案？
- [ ] 是否锁定了版本？

---

### 6.4 与 Coding Agent 协作的策略

**策略 1：明确边界的 Prompt**

```markdown
你正在修改 Reprise 项目。

## 架构规则（必须遵守）

1. **依赖方向**：
   - `core/` 不能 import `adapters/`
   - `adapters/` 可以 import `core/ports`

2. **职责分离**：
   - Orchestrator：只做生命周期协调
   - Adapter：翻译产品协议
   - Controller：决策用户输入

3. **不可变性**：
   - TraceStore 只允许 append
   - 事件一旦写入不能修改

## 在修改前

1. 确认修改属于哪个模块
2. 检查是否违反依赖规则
3. 运行 `npm test -- architecture` 验证边界
```

---

**策略 2：提供架构示例**

```typescript
// GOOD: 新增 Adapter
class CodexAdapter implements RuntimePlugin {
  // 实现 Port 接口
  async createRunner(context: RunContext): Promise<TargetRunner> {
    // ...
  }
}

// BAD: Core 依赖 Adapter
// ❌ 不要在 core/orchestrator.ts 中这样写
import { ClaudeCodeAdapter } from '../adapters/runtime/claude-code';
```

---

**策略 3：自动化修复脚本**

```typescript
// scripts/fix-imports.ts
// 自动检测并修复违反规则的 import

const violations = checkDependencies();

for (const v of violations) {
  if (v.from.startsWith('src/core') && v.to.startsWith('src/adapters')) {
    console.error(`❌ ${v.from} should not import ${v.to}`);
    // 提供修复建议
    console.log(`💡 Suggestion: Use dependency injection via Port`);
  }
}
```

---

### 6.5 定期架构审查

**每月一次**：
1. 运行所有 Fitness Functions
2. 检查模块大小和复杂度
3. Review 新增的依赖
4. 更新架构文档

**每季度一次**：
1. 评估是否需要重构
2. 考虑是否有新的架构模式适用
3. 更新 Fitness Functions 本身

---

## 7. 与现有设计的对比与优化建议

### 7.1 现有设计的优点（保留）

当前[架构总览](../architecture/overview.md)的设计已经很接近理想状态：

✓ **六边形架构**：Core + Ports + Adapters
✓ **事实审计**：Append-only trace
✓ **职责分离**：Orchestrator、Runtime、Environment、Controller 各司其职
✓ **Anti-Corruption Layer**：每个产品有自己的 Adapter
✓ **可观察性**：完整的事件记录和原始保留

---

### 7.2 建议的优化

#### 优化 1：保留四个端口，避免端口内部膨胀

保留 `RuntimePort`、`EnvironmentPort`、`AgentServicesPort` 和 `TracePort`。Environment 与同等人类能力共同构成产品价值，不能为了减少接口数量而删除；端口隔离的也是高风险外部边界，并不要求先存在第二个实现。

真正需要克制的是实现形状：不建立 Port 基类、工厂层或通用依赖注入容器。`selectEvidence` 属于报告投影，失败时只降级报告，不能改变实验终态。

#### 优化 2：七个持久状态，准备细节使用事件

```text
created
→ preparing
→ launching
→ awaiting_target
→ awaiting_controller
→ finalizing
→ finished
```

加载 case、检查 Runtime、检查环境、规划恢复和准备环境是 `preparing` 中有顺序的步骤，通过 `case.loaded`、`runtime.inspected`、`environment.inspected`、`recovery.planned` 和 `environment.prepared` 记录。状态表达当前允许的操作，事件表达已经发生的事实。

五状态模型会混淆等待 Target 与等待 Controller，并丢失启动和收尾边界；十一状态模型又把每个准备步骤都提升成了生命周期状态。七状态是更合适的中间点。

#### 优化 3：显式静态注册，契约测试位于测试代码

第一版使用普通对象、数组或函数显式注册 Runtime 和 Environment。没有第三方插件、冲突解析或动态发现需求时，不需要通用 `PluginRegistry<T>`。

契约测试由项目测试套件调用 Adapter，不放进生产插件接口，也不在每次注册时执行。它重点验证启动、发送、turn settlement、停止、失败和原始事件保留。

#### 优化 4：轻量观察加产物引用

`TargetObservation` 只内联 turn 状态、必要消息摘要和工具调用摘要。文件 diff、测试长日志、截图、二进制产物及原生事件通过 `ArtifactRef` 或 `rawRef` 引用，由 Agent Services Host 在上下文预算内按需解析。

不建立 `CoreObservation` / `DetailedObservation` 继承体系，也不让 Controller 用 detail level 反向控制 Runtime 采集。

#### 优化 5：Environment 从第一版就是正式边界

第一版可以只有一个 Local Environment Provider，但必须遵守 `inspect → plan → policy check → prepare → fingerprint → cleanup` 生命周期。默认使用隔离环境，不能因为 Git 工作树干净就直接让 Target 修改用户当前目录。

`AgentServicesPort.proposeRecovery` 根据不完整证据提出计划；确定性 Provider 验证策略、执行操作并重新 fingerprint。无法恢复时允许 observational run，但必须记录 mismatch 和不可控副作用。

---

### 7.3 精炼的架构图

基于优化建议，精炼后的架构：

```text
┌─────────────────────────────────────────────────────┐
│                    CLI / Reporter                    │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│              Experiment Orchestrator                 │
│  (状态机 + 预算 + 事件记录)                          │
└────┬────────────┬────────────┬───────────────┘
     ↓            ↓            ↓             ↓
 RuntimePort  EnvironmentPort  AgentServices  TracePort
     ↓            ↓            ↓             ↓
 Runtime       Environment     Pi Agent      JSONL
 Adapter       Provider        Services      Store
     ↓            ↓
┌─────────┐
│ Target  │
│  Agent  │
│ Runtime │
└─────────┘
```

**关键边界**：
- 4 个窄端口，分别隔离 Runtime、Environment、Agent Services 和 Trace
- 薄的 Orchestrator（只做协调）
- 可插拔的 Adapter（产品差异隔离）

---

### 7.4 核心模块的精确职责

#### Orchestrator（薄层）
```typescript
class ExperimentOrchestrator {
  // 唯一公开方法
  async run(taskCase: TaskCase, config: RunConfig): Promise<RunResult> {
    // 1. 状态：created → preparing
    const evidence = await environment.inspect(taskCase.environmentEvidence);
    const plan = await agentServices.proposeRecovery({ taskCase, evidence });
    const prepared = await environment.prepare(plan, config.recoveryPolicy);
    const runner = await runtimePlugin.createRunner({ environment: prepared });

    // 2. 状态：preparing → launching → awaiting_target
    await runner.start(taskCase.initialMessage);
    trace.append({ type: 'run_started', timestamp: now() });

    // 3. 协作循环
    while (!budget.exceeded()) {
      // 状态：awaiting_target → awaiting_controller
      const obs = await runner.waitForTurn();
      trace.append({ type: 'observation', data: obs });

      const decision = await agentServices.nextUserMessage({ taskCase, currentTurn: obs });
      trace.append({ type: 'decision', data: decision });

      if (decision.type === 'done') break;
      if (decision.type === 'send') {
        await runner.send(decision.message);
      }
      // 状态：awaiting_controller → awaiting_target
    }

    // 4. 状态：awaiting_target/controller → finalizing → finished
    await environment.cleanup(prepared, config.cleanupPolicy);
    return trace.summarize();
  }
}
```

**不做的事**：
- ✗ 解析 Claude Code 的 stream-json
- ✗ 推理环境恢复计划
- ✗ 生成用户消息
- ✗ 选择报告证据

**只做的事**：
- ✓ 状态转换
- ✓ 预算检查
- ✓ 事件记录
- ✓ 生命周期管理

---

#### RuntimeAdapter（防腐层）
```typescript
class ClaudeCodeAdapter implements RuntimePlugin {
  async createRunner(context: RunContext): Promise<TargetRunner> {
    return new ClaudeCodeRunner(context);
  }
}

class ClaudeCodeRunner implements TargetRunner {
  // 启动 claude -p，解析 stream-json
  async start(message: UserMessage): Promise<void> {
    this.process = spawn('claude', ['-p', '--model', this.model]);
    this.parser = new StreamJsonParser(this.process.stdout);
    await this.send(message);
  }

  // 原生事件优先；否则组合 transport/process 状态，最后才使用 quiet period。
  async waitForTurn(): Promise<TurnSettlement> {
    return this.settlementDetector.wait({
      nativeEvents: this.parser.events,
      process: this.process,
      fallback: 'quiet-period',
    });
  }

  // 翻译：产品特有 → 统一格式
  private buildObservation(): Observation {
    return {
      messages: this.extractMessages(this.rawEvents),
      toolCalls: this.extractToolCalls(this.rawEvents),
    };
  }
}
```

**职责**：
- 启动产品 CLI
- 解析产品事件
- 翻译成统一格式
- 保留原始事件

---

#### Controller（监督代理）
```typescript
class PiControllerAdapter implements ControllerPlugin {
  private agent: Agent;

  constructor() {
    this.agent = new Agent({
      model: 'claude-opus-5',
      systemPrompt: CONTROLLER_SYSTEM_PROMPT,
    });
  }

  async decide(context: DecisionContext): Promise<ControllerDecision> {
    const prompt = this.buildPrompt(context);
    const response = await this.agent.run(prompt);

    return this.parseDecision(response);
  }

  private buildPrompt(context: DecisionContext): string {
    return `
原始任务：${context.taskCase.summary}
历史会话：${context.taskCase.transcript}

当前 Agent 状态：
${formatObservation(context.observation)}

你已经发送的消息：
${context.priorDecisions.map(d => d.message).join('\n')}

下一步只能是：
- send(message)：给出当前轨迹真正需要的下一条用户输入
- done(reason)：任务已完成或继续输入已无意义

请输出决策。
    `;
  }
}
```

**职责**：
- 观察当前状态
- 基于能力边界决策
- 输出结构化决策

---

## 8. 实施路线图

### 8.1 第一版核心实现（2-3 周）

**目标**：端到端验证历史任务起点恢复、目标 Runtime 控制和动态同等人类能力输入。

**实现范围**：
```text
src/
├── core/
│   ├── orchestrator.ts      # 七状态生命周期
│   ├── ports/
│   │   ├── runtime.ts       # RuntimePort
│   │   ├── environment.ts   # EnvironmentPort
│   │   ├── agent-services.ts# AgentServicesPort
│   │   └── trace.ts         # TracePort
│   └── types.ts             # 共享类型
│
├── adapters/
│   ├── claude-code.ts       # 唯一的 Runtime
│   ├── local-environment.ts # 隔离的本地环境
│   ├── pi-agent-services.ts # 恢复、steering、报告能力
│   └── jsonl-trace.ts       # 唯一的 Trace
│
└── cli/
    └── run.ts               # 最小 CLI
```

**不实现**：
- ✗ 插件注册表（只有一个实现）
- ✗ 多个 Adapter
- ✗ 复杂报告

**验证点**：
1. 能从证据准备隔离环境，且不修改用户原目录
2. 能启动 Claude Code，并以多信号识别 turn settlement
3. Pi Agent Services 能生成恢复计划和下一条用户输入
4. 事件、原始数据、实际运行条件和 mismatch 完整记录

---

### 8.2 第二版：第二个 Runtime 与契约验证（1 周）

**目标**：用 Codex Adapter 证明 RuntimePort 没有泄漏 Claude Code 私有语义。

**实现**：
- 实现 Codex Runtime Adapter
- 让两个 Adapter 通过同一组外部契约测试
- 保持显式静态注册；只有真实选择冲突出现时才提取 Registry

**触发条件**：
- 有用户需要支持 Codex/Cursor
- 或者需要测试不同的 Controller 策略

---

### 8.3 第三版：扩展环境恢复能力（1-2 周）

**目标**：在已有 Local Provider 之外支持更多可验证的历史起点。

**实现**：
- 实现 `GitEnvironmentProvider`
- 按真实任务需要扩展文件系统、浏览器或自定义 Provider

**触发条件**：已有任务证据无法由 Local Provider 可靠恢复。

---

### 8.4 可选的实现守护（按腐化证据引入）

**目标**：防止架构腐化

**实现**：
- 依赖方向检查
- Adapter 契约测试
- 关键 Trace 不变量检查

**集成到 CI**：
```yaml
# .github/workflows/architecture.yml
name: Architecture Tests
on: [push, pull_request]

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - run: npm test -- architecture
      - run: npm run check-dependencies
```

---

## 9. 关键决策总结

### 9.1 架构决策

| 问题 | 决策 | 理由 |
|------|------|------|
| 核心架构模式 | Hexagonal Architecture | 依赖倒置，Core 与外部隔离 |
| 防腐层 | Anti-Corruption Layer | 每个产品有独立 Adapter |
| 部署模式 | Modular Monolith | 单进程，清晰边界，可后续拆分 |
| 事件存储 | Append-only audit log | 完整审计，但不承诺外部副作用重放 |
| 权限模型 | Capability-Based | 最小权限，沙箱隔离 |
| 演进策略 | Fitness Functions | 自动化边界检查 |

---

### 9.2 简化决策

| 稳定边界 | 第一版做法 | 何时扩展 |
|----------|------------|----------|
| 4 个端口 | 保留窄接口，不加基类和 DI 容器 | 只在真实实现要求下扩充方法 |
| 7 个状态 | 准备细节记录为事件 | 新状态必须改变合法操作或资源所有权 |
| Environment | Agent 规划 + Local Provider 确定执行 | 有真实任务时增加 Provider |
| Evidence Selection | 作为非阻塞报告投影 | 报告需求出现后增加展示形式 |
| 插件加载 | 显式静态注册 | 有第三方插件时再考虑动态加载 |

---

### 9.3 不变的原则

无论如何演进，这些原则不变：

1. **依赖方向**：Core 不依赖 Adapters
2. **职责分离**：Orchestrator 只做协调
3. **事件不可变**：Trace 是 append-only
4. **原始保留**：产品事件完整保存在 raw/
5. **可观察性**：每个决策都有 reason 可追溯

---

## 10. 成功标准

### 10.1 架构质量

一个好的架构应该：

- ✓ **易于理解**：新人能在 1 小时内理解核心结构
- ✓ **易于测试**：每个组件可独立测试
- ✓ **易于扩展**：新增 Adapter 不需要修改 Core
- ✓ **易于维护**：修改一个模块不影响其他模块
- ✓ **不易腐化**：Fitness Functions 自动检查边界

不使用“Core 少于十个文件”“平均文件少于两百行”或统一覆盖率等任意数字代替架构判断。真正可执行的验证应对应产品不变量：Core 不依赖具体 Adapter、原始事件不丢失、Environment 不越权、失败路径进入 finalizing，以及新增 Runtime 不修改实验语义。

---

### 10.2 可扩展性验证

**测试场景**：新增一个 Codex Adapter

**应该只需要**：
1. 创建 `src/adapters/codex.ts`
2. 实现 `RuntimePlugin` 接口
3. 通过契约测试
4. 在 `main.ts` 中注册

**不应该需要**：
- ✗ 修改 `core/orchestrator.ts`
- ✗ 修改 `core/ports/runtime.ts`
- ✗ 修改其他 Adapter
- ✗ 修改测试（除了新增 Codex 专属测试）

---

### 10.3 与 Coding Agent 协作

**测试场景**：让 Coding Agent 添加一个新功能

**Agent 应该能**：
1. 识别应该在哪个模块添加代码
2. 遵守依赖规则（不违反 Fitness Functions）
3. 保持一致的代码风格和命名

**Agent 不应该**：
- ✗ 在 Core 中添加产品特有逻辑
- ✗ 创建循环依赖
- ✗ 绕过 Port 接口直接访问 Adapter

**验证方法**：
```bash
# 让 Agent 添加功能后运行
npm test -- architecture
npm run check-dependencies
npm run lint
```

如果全部通过，说明架构足够清晰。

---

## 11. 参考资料

### 核心理论
- [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/) - Alistair Cockburn
- [Anti-Corruption Layer](https://docs.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer) - Microsoft
- [Modular Monolith](https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer) - Kamil Grzybek
- [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) - Martin Fowler
- [Capability-Based Security](https://en.wikipedia.org/wiki/Capability-based_security) - Wikipedia
- [Evolutionary Architecture](https://www.thoughtworks.com/insights/books/building-evolutionary-architectures) - Thoughtworks

### Agent Harness 研究
- [Harness Engineering: The Agent Control Plane](https://www.tmls.nyc/research/harness-engineering) - TMLS
- [Pi Agent Framework](https://github.com/earendil-works/pi) - Earendil Works
- [Harbor Framework](https://github.com/harbor-framework/harbor) - Harbor

### 实践参考
- [Fitness Functions](https://www.thoughtworks.com/insights/blog/fitness-function-driven-development) - Thoughtworks
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) - 依赖检查工具
- [OSGi Service Platform](https://www.osgi.org/) - 成熟的模块化系统

---

## 12. 结论

基于 Hexagonal Architecture、Anti-Corruption Layer、Modular Monolith、append-only audit log、Capability-Based Security 和 Evolutionary Architecture，结合 Pi Agent 的设计哲学，可以得到一个克制的架构检查框架。具体产品架构仍以[架构总览](../architecture/overview.md)为准：

### 核心特征

1. **薄的编排层**：Orchestrator 只做生命周期协调
2. **四个核心端口**：Runtime / Environment / Agent Services / Trace
3. **可插拔适配器**：产品差异隔离在 Adapter
4. **两个关注点**：环境恢复 + 同等人类能力
5. **事实审计**：Append-only trace，完整可追溯但不假设副作用可重放
6. **按需守护**：只把真实不变量转成自动检查

### 演进策略

- **第一版**：一个 Runtime、一个 Environment Provider、四个窄端口和动态 Agent Services
- **第二版**：用第二个 Runtime 验证防腐边界
- **第三版**：按真实任务扩展 Environment Provider
- **后续**：只有出现腐化或第三方扩展需求时才增加守护和插件机制

### 不变的原则

- 依赖方向：Core 不依赖 Adapters
- 职责分离：每个组件只做一件事
- 事件不可变：Trace 是 append-only
- 原始保留：产品事件完整保存
- 可观察性：每个决策可追溯

这个架构不是大而全的框架，而是**少量明确原语的组合，遵循 Pi Agent 的品味：清晰、克制、可演进**。

---

## 13. 协议研究补充：输入接受与中断收尾

本节吸收 Pi 和 Codex 的实际实现观察；规范性接口以[架构总览](../architecture/overview.md)第 14 节为准。

### 13.1 接受边界

成熟 Agent 产品都把“输入被接受”和“整轮完成”分开：

- Pi RPC 在 prompt preflight 成功后返回成功，`agent_settled` 才代表运行结束；
- Codex `turn/start` 返回已分配的 `turnId`，`turn/started` 是后续执行事件；
- 因此 `TargetRunner.send` 应返回 `SendReceipt`，不能用等待整轮的 Promise 代替 accepted 语义。

```text
accepted  ≠  started  ≠  settled
```

`delivery: "unknown"` 不是失败。适配器应使用稳定的 `clientMessageId`、turn/session id 或原生查询确认旧请求；无法确认时禁止自动重发，转入收尾。

参考实现：[Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts)、[Pi Agent lifecycle](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)、[Codex turn processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/turn_processor.rs)。

### 13.2 中断与重试

`preparing` 不是可任意回放的事务，`finalizing` 也不应重新运行任务。恢复判断依赖：

```text
已持久化 operation 事实 + 当前外部状态 + 操作幂等性
```

可重试的主要是读取、fingerprint、受 run ID 约束的临时资源、原子 manifest 写入，以及属于本次 run 的停止和清理。启动响应丢失、消息 delivery 未知、用户目录部分修改、外部不可逆副作用都不能盲目重放；应查询、隔离、记录并结束。

这与 Pi 的 abort 后等待 idle，以及 Codex 的 interrupt 后等待最终 turn 状态一致。清理失败不覆盖原始 outcome，`finished` 可以携带部分清理错误。

参考实现：[Pi abort/waitForIdle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)、[Codex user message admission](https://github.com/openai/codex/blob/main/codex-rs/core/src/user_message_admission.rs)、[Codex App Server lifecycle](https://learn.chatgpt.com/docs/app-server#api-overview)。

### 13.3 对架构的约束

- 七个生命周期状态保持不变；`unknown`、`runtime_drift`、`cleanupStatus` 是结果字段或事件，不扩张状态机。
- Trace 记录 `send_requested`、`send_accepted`、`send_rejected`、`send_unknown`，并保存原生 receipt/raw 证据。
- 所有重试都创建新的 attempt 事件；不覆盖旧事实，也不把“事件已存在”当作外部动作已完成。
- `finalizing` 只允许等待、停止、清理、fingerprint、trace flush 和报告投影，不允许新增 Controller decision。
