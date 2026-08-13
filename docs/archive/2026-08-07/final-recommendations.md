# Reprise 设计深度分析总结

状态：最终建议 v1.0
日期：2026-08-07

---

## 摘要

本文档整合了 Controller 设计和架构设计的深度分析，基于认知科学、软件架构理论和 Pi Agent 设计哲学，提出 Reprise 的精炼实施方案。

**核心洞察**：
1. Controller 不是通用人类模拟器，而是**有固定能力边界的监督代理**
2. 架构应该是**薄的编排层 + 可插拔适配器**，保持两个关注点分离
3. 第一版应该**极简验证**，避免过早抽象

---

## 一、两个核心关注点

### 1.1 关注点一：同等人类协作（Controller）

#### 理论基础
- **Mixed-Initiative Interaction**：主动权动态分配，不是固定的"人指挥机器"
- **Grounding Theory**：持续建立共同理解，历史消息不是永远有效的脚本
- **Scaffolding**：提供恰好足够的帮助，在 Zone of Proximal Development 内工作
- **Joint Cognitive System**：认知分布在用户、Controller、Agent、工具、环境中
- **Supervisory Control**：监督者观察状态，正常时放手，偏离时介入

#### 精炼模型

**四维能力边界**：
| 能力 | 含义 | 来源 |
|------|------|------|
| 目标能力 | 知道任务目标和验收标准 | 原始会话描述 |
| 领域能力 | 掌握的事实、术语、偏好 | 历史会话内容 |
| 监督能力 | 发现偏差和验证需求 | 历史纠正行为 |
| 授权能力 | 知道什么需要确认 | 权限和风险评估 |

**三类介入动作**：
- `inform`：补充 Agent 缺失的事实（Grounding）
- `correct`：纠正已偏离的方向（Direction Maintenance）
- `verify`：要求 Agent 展示验证（Supervisory Control）

**最小实现**：
```typescript
interface ControllerPort {
  decide(context: DecisionContext): Promise<ControllerDecision>;
}

type ControllerDecision =
  | { type: "wait"; reason: string }
  | { type: "send"; intent: "inform" | "correct" | "verify"; message: string; reason: string }
  | { type: "done"; reason: string };
```

---

### 1.2 关注点二：会话环境恢复（Environment）

#### 理论基础
- **Checkpoint/Restore**：捕获完整状态到磁盘，后续恢复到相同点
- **Capability-Based Security**：只给予需要的能力，不是全部权限
- **Immutable Infrastructure**：环境状态应该是可验证的、可重现的

#### 精炼模型

**三级恢复策略**：
| 模式 | 含义 | 何时使用 |
|------|------|----------|
| `none` | 直接使用当前环境 | 环境干净，无需隔离 |
| `copy` | 复制到临时目录 | 有未提交修改，需要隔离 |
| `checkpoint` | 从 git commit/快照恢复 | 需要恢复历史状态 |

**渐进式实现**：
```text
第一版：简单规则
hasUncommittedChanges() ? copy() : useCurrentDir()

第二版：Provider 接口
interface EnvironmentProvider {
  prepare(evidence: Evidence): PreparedEnvironment;
  cleanup(env: PreparedEnvironment): void;
}

第三版：Agent 辅助规划（仅当必要）
interface EnvironmentPort {
  proposeRecovery(context): Promise<Plan>;
  prepare(plan: Plan): Promise<PreparedEnvironment>;
}
```

---

## 二、精炼的架构设计

### 2.1 核心架构模式

基于以下六个理论：

1. **Hexagonal Architecture**：Core 定义端口，外部适配
2. **Anti-Corruption Layer**：每个产品有独立 Adapter
3. **Modular Monolith**：单进程，清晰边界，可后续拆分
4. **Event Sourcing**：Append-only log，完整审计
5. **Capability-Based Security**：最小权限原则
6. **Evolutionary Architecture**：Fitness Functions 防止腐化

### 2.2 三个核心端口

**第一版只需要三个端口**：

```typescript
// 1. RuntimePort - Target Agent 的抽象
interface RuntimePort {
  discoverSessions(source?: SessionSource): Promise<SessionRef[]>;
  inspectSession(ref: SessionRef): Promise<RuntimeEvidence>;
  createRunner(context: RunContext): Promise<TargetRunner>;
}

interface TargetRunner {
  start(message: UserMessage): Promise<void>;
  send(message: UserMessage): Promise<void>;
  waitForTurn(timeout?: number): Promise<Observation>;
  onEvent(handler: (event: RawEvent) => void): Unsubscribe;
  stop(reason: StopReason): Promise<void>;
}

// 2. ControllerPort - 用户协作的抽象
interface ControllerPort {
  decide(context: DecisionContext): Promise<ControllerDecision>;
}

// 3. TracePort - 事件存储的抽象
interface TracePort {
  append(event: TraceEvent): Promise<void>;
  read(filter?: EventFilter): Promise<TraceEvent[]>;
  snapshot(): Promise<RunSnapshot>;
}
```

**暂不实现**：
- ✗ EnvironmentPort（第一版用简单函数）
- ✗ proposeRecovery（用规则代替）
- ✗ selectEvidence（固定规则）

---

### 2.3 薄的编排层

Orchestrator 只做一件事：**协调生命周期**

```typescript
class ExperimentOrchestrator {
  async run(taskCase: TaskCase, config: RunConfig): Promise<RunResult> {
    // 1. 准备环境（简单函数）
    const workDir = await prepareEnvironment(taskCase);

    // 2. 启动 Runtime
    const runner = await runtimePlugin.createRunner({ workDir });
    await runner.start(taskCase.initialMessage);

    // 3. 协作循环
    while (!budget.exceeded()) {
      const observation = await runner.waitForTurn();
      trace.append({ type: 'observation', data: observation });

      const decision = await controller.decide({ taskCase, observation });
      trace.append({ type: 'decision', data: decision });

      if (decision.type === 'done') break;
      if (decision.type === 'send') {
        await runner.send(decision.message);
      }
    }

    // 4. 清理
    await cleanup(workDir);
    return trace.summarize();
  }
}
```

**Orchestrator 不做**：
- ✗ 解析产品协议（在 Adapter）
- ✗ 生成用户消息（在 Controller）
- ✗ 恢复环境（在 Provider）
- ✗ 格式化报告（在 Reporter）

---

### 2.4 代码组织

**第一版目录结构**（极简）：

```text
reprise/
├── src/
│   ├── core/
│   │   ├── orchestrator.ts      # 薄的编排层
│   │   ├── ports/
│   │   │   ├── runtime.ts       # RuntimePort
│   │   │   ├── controller.ts    # ControllerPort
│   │   │   └── trace.ts         # TracePort
│   │   └── types.ts             # 共享类型
│   │
│   ├── adapters/
│   │   ├── claude-code.ts       # 唯一的 Runtime
│   │   ├── pi-controller.ts     # 唯一的 Controller
│   │   └── jsonl-trace.ts       # 唯一的 Trace
│   │
│   └── cli.ts                   # 最小 CLI
│
├── tests/
│   ├── architecture.test.ts     # Fitness Functions
│   └── e2e.test.ts              # 端到端测试
│
├── package.json
└── tsconfig.json
```

**核心原则**：
- `core/` 不依赖 `adapters/`
- 没有第二个实现时，不创建抽象
- 第一版 < 1000 行代码

---

## 三、防止架构腐化

### 3.1 Fitness Functions（架构守护）

自动化检查架构边界：

```typescript
// tests/architecture.test.ts

// Fitness Function 1: 依赖方向
test('core should not depend on adapters', () => {
  const violations = checkDependencies('src/core', 'src/adapters');
  expect(violations).toEqual([]);
});

// Fitness Function 2: 接口稳定性
test('RuntimePort has not changed unexpectedly', () => {
  const current = extractInterface('src/core/ports/runtime.ts');
  const baseline = loadBaseline('RuntimePort');
  expect(current.methods).toContainAll(baseline.methods);
});

// Fitness Function 3: 事件不可变
test('TraceStore is append-only', () => {
  const store = new TraceStore();
  expect(store.update).toBeUndefined();
  expect(store.delete).toBeUndefined();
});

// Fitness Function 4: 模块大小
test('no file exceeds 300 lines', () => {
  const files = glob.sync('src/**/*.ts');
  for (const file of files) {
    const lines = countLines(file);
    expect(lines).toBeLessThan(300);
  }
});
```

集成到 CI：
```yaml
# .github/workflows/architecture.yml
name: Architecture Guard
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -- architecture
      - run: npm run check-dependencies
```

---

### 3.2 与 Coding Agent 协作

**策略 1：明确的 Prompt**
```markdown
## 架构规则（必须遵守）

1. `core/` 不能 import `adapters/`
2. Orchestrator 只做生命周期协调
3. TraceStore 只允许 append
4. 修改前运行 `npm test -- architecture`
```

**策略 2：提供示例**
```typescript
// ✓ GOOD: 新增 Adapter
class CodexAdapter implements RuntimePlugin {
  async createRunner(context: RunContext): Promise<TargetRunner> {
    // ...
  }
}

// ✗ BAD: Core 依赖 Adapter
// 不要在 core/orchestrator.ts 中这样写
import { ClaudeCodeAdapter } from '../adapters/claude-code';
```

**策略 3：自动修复**
```typescript
// scripts/fix-imports.ts
const violations = checkDependencies();
for (const v of violations) {
  console.error(`❌ ${v.from} should not import ${v.to}`);
  console.log(`💡 Use dependency injection via Port`);
}
```

---

## 四、实施建议

### 4.1 立即行动（本周）

**1. 创建最小原型（200 行）**
```typescript
// prototype/verify.ts
// 验证：能否启动 Claude Code + Pi Controller 生成消息

import { spawn } from 'child_process';
import { Agent } from '@earendil-works/pi-agent-core';

async function main() {
  // 1. 启动 Claude Code
  const proc = spawn('claude', ['-p', '--model', 'claude-sonnet-4']);

  // 2. Pi Controller
  const controller = new Agent({
    model: 'claude-opus-5',
    systemPrompt: CONTROLLER_PROMPT,
  });

  // 3. 循环
  for (let turn = 0; turn < 3; turn++) {
    const observation = await waitForTurn(proc);
    const decision = await controller.run(formatObservation(observation));

    if (decision.includes('DONE')) break;
    proc.stdin.write(decision + '\n');
  }
}
```

**验证点**：
- Controller 生成的消息是否合理？
- Turn boundary 识别是否准确？
- 整个流程是否可行？

---

### 4.2 第一版实施（2-3 周）

**Week 1: Core + 单个 Adapter**
```text
Day 1-2: 创建目录结构，定义 Port 接口
Day 3-4: 实现 ClaudeCodeAdapter
Day 5-7: 实现 Orchestrator（5 个状态）
```

**Week 2: Controller + Trace**
```text
Day 8-10: 实现 PiControllerAdapter
Day 11-12: 实现 JsonlTraceStore
Day 13-14: 集成测试
```

**Week 3: CLI + 验证**
```text
Day 15-16: 实现最小 CLI
Day 17-18: 用 3-5 个真实会话测试
Day 19-21: 修复问题，优化体验
```

**交付物**：
- 能对比一个历史会话在不同模型下的表现
- 生成 Markdown 报告
- 代码 < 1000 行
- 通过所有 Fitness Functions

---

### 4.3 第二版：提取接口（1 周）

**触发条件**：
- 有用户需要支持 Codex/Cursor
- 需要测试不同的 Controller 策略

**实施**：
1. 添加插件注册表
2. 添加契约测试
3. 实现第二个 Adapter
4. 验证可扩展性

---

### 4.4 第三版：环境隔离（1-2 周）

**触发条件**：
- 用户反馈"运行后目录被污染"
- 需要恢复历史 git commit

**实施**：
1. 添加 `EnvironmentProvider` 接口
2. 实现 `GitEnvironmentProvider`
3. 实现 `FileSystemProvider`
4. 更新 Orchestrator 使用 Provider

---

## 五、与现有设计的对比

### 5.1 保留的优点

当前设计已经很好，应该保留：

✓ **理论基础扎实**：Mixed-Initiative、Grounding、Scaffolding
✓ **六边形架构**：Core + Ports + Adapters
✓ **事件溯源**：Append-only trace
✓ **四维能力模型**：目标、领域、监督、授权
✓ **三类介入动作**：inform / correct / verify
✓ **观察面设计**：三层可见性边界

---

### 5.2 建议的简化

| 当前设计 | 建议简化 | 理由 |
|----------|----------|------|
| 4-5 个端口 | 3 个端口 | 第一版只需 Runtime / Controller / Trace |
| 11 个状态 | 5 个状态 | created → preparing → running → awaiting → finished |
| Environment Agent | 简单规则 | hasUncommittedChanges() ? copy() : current() |
| proposeRecovery | 不实现 | 等恢复失败率 > 30% 再引入 |
| selectEvidence | 固定规则 | diff + 测试输出 + 最后消息 |
| 动态插件 | 静态注册 | 没有第三方插件需求 |

---

### 5.3 新增的内容

基于理论研究，建议新增：

**1. Fitness Functions**（架构守护）
- 依赖方向检查
- 接口稳定性检查
- 事件不可变检查
- 模块大小检查

**2. 契约测试**（插件质量）
```typescript
interface Plugin<T> {
  contractTests(): TestSuite;
}
```

**3. 插件注册表**（可扩展性）
```typescript
class PluginRegistry<T> {
  register(plugin: Plugin<T>): void;
  select(predicate): Plugin<T> | undefined;
}
```

**4. 渐进式环境恢复**
```text
第一版：简单函数
第二版：Provider 接口
第三版：Agent 辅助（可选）
```

---

## 六、成功标准

### 6.1 理论一致性

- ✓ Controller 基于 5 个认知科学理论
- ✓ 架构基于 6 个软件架构理论
- ✓ 每个设计决策都能追溯到理论依据

### 6.2 实现简洁性

- ✓ 第一版 < 1000 行代码
- ✓ 核心文件 < 10 个
- ✓ 单文件 < 300 行
- ✓ 依赖 < 5 个（Pi + execa + fs-extra）

### 6.3 可扩展性

**测试**：新增一个 Codex Adapter

**应该只需要**：
1. 创建 `codex.ts`（200 行）
2. 实现 `RuntimePlugin`
3. 通过契约测试
4. 注册插件

**不应该修改**：
- ✗ `core/orchestrator.ts`
- ✗ `core/ports/runtime.ts`
- ✗ 其他 Adapter

### 6.4 不易腐化

- ✓ Fitness Functions 全部通过
- ✓ 依赖方向检查通过
- ✓ Coding Agent 添加功能后架构测试仍通过

---

## 七、最终建议

### 7.1 核心建议

1. **Controller 设计**
   - 采用四维能力边界 + 三类介入动作
   - 第一版只做 `nextUserMessage`
   - 基于 Pi Agent，保持简单

2. **架构设计**
   - 采用 Hexagonal Architecture + Anti-Corruption Layer
   - 第一版只实现 3 个端口
   - 薄的 Orchestrator，可插拔 Adapter

3. **实施策略**
   - 先写 200 行原型验证核心假设
   - 第一版极简（< 1000 行）
   - 用 Fitness Functions 防止腐化

4. **演进路径**
   - 有第二个实现时才抽象
   - 环境恢复从简单规则开始
   - 根据实际需求渐进式增加复杂度

---

### 7.2 行动清单

**本周**：
- [ ] 写 200 行原型，验证 Controller 可行性
- [ ] 定义 3 个 Port 接口
- [ ] 创建目录结构

**下周**：
- [ ] 实现 ClaudeCodeAdapter
- [ ] 实现 PiControllerAdapter
- [ ] 实现 Orchestrator

**第三周**：
- [ ] 实现 CLI
- [ ] 用 3-5 个真实会话测试
- [ ] 添加 Fitness Functions

**验证点**：
- Controller 生成的消息质量
- 架构边界是否清晰
- 代码是否简洁

---

### 7.3 关键原则（不变）

无论如何演进，这些原则永远不变：

1. **理论驱动**：每个设计决策有理论依据
2. **依赖方向**：Core 不依赖 Adapters
3. **职责分离**：Orchestrator 只做协调
4. **事件不可变**：Trace 是 append-only
5. **原始保留**：产品事件完整保存
6. **可观察性**：每个决策可追溯
7. **克制优先**：没有第二个实现时不抽象

---

## 八、参考文档

**本次分析创建的文档**：
- `controller-deep-analysis.md` - Controller 设计深度分析
- `architecture-deep-analysis.md` - 架构设计深度分析
- `final-recommendations.md` - 本文档

**原有设计文档**：
- `equivalent-human-collaboration.md` - Controller 理论基础
- `minimal-agent-harness-design.md` - 产品定义
- `architecture-discussion.md` - 架构讨论

**理论参考**：
- Mixed-Initiative Interaction (Horvitz 1999)
- Grounding Theory (Clark & Brennan 1991)
- Scaffolding (Wood, Bruner & Ross 1976)
- Joint Cognitive Systems (Hollnagel & Woods 2005)
- Supervisory Control (Parasuraman et al. 2000)
- Hexagonal Architecture (Alistair Cockburn)
- Anti-Corruption Layer (Eric Evans)
- Event Sourcing (Martin Fowler)
- Evolutionary Architecture (Thoughtworks)
- Pi Agent Design Philosophy

---

## 结论

基于深入的理论研究和架构分析，我们提出了一个**克制、精炼、理论支撑、不易腐化**的设计：

**Controller**：
- 不是通用人类模拟器
- 而是有固定能力边界的监督代理
- 基于 5 个认知科学理论
- 四维能力 + 三类介入

**架构**：
- 不是大而全的框架
- 而是薄的编排层 + 可插拔适配器
- 基于 6 个软件架构理论
- 3 个端口 + Fitness Functions

**实施**：
- 不是一次性设计完美架构
- 而是渐进式验证和演进
- 200 行原型 → 1000 行第一版 → 按需扩展
- 用 Fitness Functions 防止腐化

这个设计遵循 **Pi Agent 的品味**：少量明确原语、事件流、组合优先、避免宏大框架。
