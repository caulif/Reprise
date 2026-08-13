# Reprise 优化建议

状态：设计审查 v1.0
日期：2026-08-07

## 1. 核心原则：保持克制

项目已经有清晰的理论基础和架构边界。后续优化应遵循：

- **理论清晰**：设计决策基于明确的理论依据，不靠直觉堆砌功能
- **架构克制**：只实现必需的抽象层，不预测未来需求
- **代码简单**：优先用普通对象和函数，能用 100 行解决的不写 1000 行
- **删除优先**：没有第二个真实实现时，不创建扩展点
- **事实优先**：能确定性采集的不交给 Agent 推理

## 2. 当前设计的优点

### 理论层面
✓ 问题定义清晰：个人效用评估，不是公共 benchmark
✓ 理论依据扎实：Mixed-initiative、Grounding、Scaffolding 支撑动态输入设计
✓ 诚实的实验强度：`strict_match` / `version_mismatch` / `observational` 分级
✓ 避免公平性幻觉：同等能力边界，而非相同文字

### 架构层面
✓ 六边形架构：核心与适配器隔离
✓ Anti-Corruption Layer：防止闭源产品污染核心
✓ Append-only trace：可追溯性
✓ 控制平面与执行平面分离
✓ 依赖方向清晰：稳定核心 ← 不稳定适配器

### 工程层面
✓ 复用 Pi Agent Core，不重新实现 Agent 框架
✓ 分阶段实施：单会话 → 自动发现 → 证据自动化 → 更多环境
✓ 最小接口：RuntimePort / EnvironmentPort / AgentServicesPort
✓ 事实与推理分离：确定性采集 vs Agent 计划

## 3. 需要克制的地方

### 3.1 不要过早抽象

**当前风险**：设计文档已经定义了很多接口和类型。

**建议**：
- 第一版只实现一个 Runtime Plugin (Claude Code) 和一个 Environment Provider (Git)
- 当有第二个真实实现时，再提取共同接口
- 接口先写在同一个文件，不要立刻拆成独立包

**具体**：
```text
第一版目录结构：
reprise/
├── core/
│   ├── experiment.ts      # Orchestrator 状态机
│   ├── trace.ts           # 事件存储
│   └── types.ts           # 共享类型
├── claude-code.ts         # 第一个 Runtime 实现
├── git-env.ts             # 第一个 Environment 实现
├── pi-controller.ts       # 基于 Pi 的 Controller
└── cli.ts                 # 命令行入口
```

不要在第一版就建立 `adapters/` / `plugins/` / `registry/` 目录。

### 3.2 Controller 保持单一职责

**当前风险**：文档提到 Controller 有三个能力（proposeRecovery / nextUserMessage / selectEvidence）。

**建议**：
- 第一版 Controller 只做一件事：`nextUserMessage`
- 环境恢复第一版用简单规则：有 git commit 就用，没有就 copy
- 证据选择第一版用固定规则：diff + 测试输出 + 最后一条 Agent 消息

**原因**：
- 避免 Controller 变成「万能 Agent」
- 三个能力的上下文不同，放在一起会混淆
- proposeRecovery 的价值不确定，先用简单规则验证需求

**后续扩展时机**：
- 当简单规则覆盖不了 10+ 真实会话时，再引入 proposeRecovery
- 当用户频繁抱怨「报告没展示我关心的内容」时，再引入 selectEvidence

### 3.3 事件类型不要过度设计

**当前风险**：文档提到统一事件模型、schema version、归一化。

**建议**：
- 第一版只记录三类事件：`user_message` / `assistant_message` / `run_finished`
- 原始产品事件完整保存在 `raw/` 目录，不急于归一化
- 当需要对比两个产品的事件时，再设计归一化层

**具体**：
```ts
// 第一版够用的事件
type TraceEvent =
  | { type: "user_message"; content: string; timestamp: string }
  | { type: "assistant_message"; content: string; timestamp: string }
  | { type: "run_finished"; reason: string; timestamp: string }
  | { type: "raw"; source: "claude-code"; data: unknown };
```

不需要 `turn_completed` / `tool_call` / `artifact_created` 等十几种事件类型。

### 3.4 Turn boundary 先用简单策略

**当前风险**：文档设计了三层信号（native event / composite / heuristic）。

**建议**：
- Claude Code 有 `turn.completed` 事件，直接用
- 如果将来支持没有 turn 事件的产品，再引入 fallback
- 不要在第一版实现 heartbeat、quiet period、composite state

**原因**：
- 三层策略增加复杂度，但第一个产品可能不需要
- Turn boundary 识别错误的后果是什么？Controller 多等或少等一会，不是致命问题
- 可以先用简单策略跑几十个会话,观察实际问题再优化

## 4. 关键简化建议

### 4.1 第一版架构

```text
核心组件（必需）：
1. ExperimentOrchestrator  # 状态机：加载 → 启动 → 等待 turn → 请求 Controller → 继续 / 完成
2. ClaudeCodeRunner        # 启动 claude -p，解析 stream-json，判断 turn 结束
3. GitEnvironment          # 检查 git status，必要时 copy 目录
4. PiController            # 基于 Pi 的 nextUserMessage 实现
5. TraceStore              # append-only 写入 events.jsonl

辅助功能（可选）：
6. ReportRenderer          # 读取 trace，生成 HTML（可以先用模板引擎）
7. SessionLoader           # 从 ~/.claude/sessions 读取历史会话（可以先手动指定路径）
```

**不需要的组件**：
- RuntimePort 接口（只有一个实现时不需要接口）
- EnvironmentPort 接口（同上）
- RuntimeResolver / EnvironmentResolver（先用直接调用）
- Evidence Selection Agent（先用固定规则）
- 插件注册表、动态加载、依赖注入容器

### 4.2 状态机简化

文档中的状态机有 11 个状态。第一版可以简化为 5 个：

```text
created
  -> preparing      # 检查环境，必要时 copy
  -> running        # 启动 Target Runner
  -> awaiting       # 等待 turn 结束，请求 Controller 决策
       ├── send -> running
       └── done -> finished
  -> finished
```

异常情况直接跳到 `finished`，记录 reason。

### 4.3 Controller 决策简化

文档提出 `inform` / `correct` / `verify` 三分法。第一版可以简化：

```ts
type ControllerDecision =
  | { type: "send"; message: string }
  | { type: "done"; reason: string };
```

不需要 intent 标签。当有 20+ 真实运行后，人工分析 Controller 的消息类型，再决定是否引入三分法。

### 4.4 环境恢复简化

文档提出 `proposeRecovery` / `prepare` / `fingerprint` / `cleanup`。第一版可以简化为：

```ts
interface Environment {
  prepare(): Promise<{ workDir: string; gitCommit?: string }>;
  cleanup(): Promise<void>;
}
```

逻辑：
- 检查当前目录是否有 uncommitted changes
- 有：创建临时目录 copy
- 没有：直接使用当前目录，记录 git commit

不需要 Agent 推理恢复计划。

## 5. 实施路线（克制版）

### 阶段零：验证核心假设（1 周）
**目标**：用最简单的代码验证「动态 Controller」是否可行。

**实现**：
```text
写一个 200 行脚本：
1. 读取一个历史 Claude Code 会话
2. 启动 claude -p，发送初始消息
3. 等待 turn.completed 事件
4. 用 Pi 生成下一条用户输入
5. 循环 3-4，直到 Controller 返回 done
6. 保存 transcript
```

**验证点**：
- Pi Controller 生成的用户输入是否合理？
- Turn 结束判断是否准确？
- 是否能完成一个简单任务？

**如果失败**：说明核心假设有问题，设计需要调整。

### 阶段一：单会话对照（2-3 周）
**目标**：能对比一个历史会话在不同模型下的表现。

**必需功能**：
- 手动指定历史会话路径
- 手动指定目标模型
- 启动 Claude Code，注入 Controller 消息
- 记录事件到 `runs/<run-id>/events.jsonl`
- 生成简单对比报告（Markdown 即可，不需要 HTML）

**不做**：
- 自动发现会话
- 环境恢复（直接在当前目录运行）
- 复杂的证据选择
- 漂亮的报告界面

**验证点**：
- 用 3-5 个真实历史会话测试
- 人工检查 Controller 生成的用户输入质量
- 人工检查报告是否能帮助决策

### 阶段二：环境隔离（1-2 周）
**目标**：避免污染用户当前目录。

**必需功能**：
- 检查 git status
- 有 uncommitted changes：copy 到临时目录
- 运行后清理临时目录

**不做**：
- 恢复历史 git commit（用户可以手动 checkout）
- 复杂的 fingerprint
- 浏览器、数据库等其他环境

### 阶段三：会话发现（1-2 周）
**目标**：自动列出本机的历史会话。

**必需功能**：
- 扫描 `~/.claude/sessions/`
- 提取任务摘要（从第一条用户消息）
- 按时间排序
- 用户选择一个运行

**不做**：
- 会话质量评分
- 智能推荐
- 批量运行

### 阶段四：改进报告（1 周）
**目标**：让报告更易读。

**必需功能**：
- 并排对比：原始会话 vs 新运行
- 高亮差异：第几轮开始不同
- 展示关键证据：diff、测试输出、截图
- 客观指标：时间、token、成本

**不做**：
- 复杂的可视化
- 交互式报告
- 自定义证据选择

## 6. 具体技术建议

### 6.1 依赖最小化

**必需依赖**：
- `@earendil-works/pi-agent-core`：Controller 实现
- `execa`：启动子进程
- `fs-extra`：文件操作（copy 目录）

**可选依赖**：
- 模板引擎（如 `mustache`）：生成报告
- `zod`：运行时类型校验

**不需要的依赖**：
- 复杂的 IoC 容器
- ORM
- GraphQL / RPC 框架
- 前端构建工具（第一版报告用静态 HTML）

### 6.2 数据格式

**Trace 格式**：
```text
runs/<run-id>/
├── manifest.json          # 运行条件：模型、环境、配置
├── events.jsonl           # 每行一个 JSON 事件
├── raw/                   # 原始产品输出
│   └── claude-code.jsonl
└── report.md              # 生成的报告
```

**事件格式**：
```jsonl
{"type":"user_message","content":"...","timestamp":"2026-08-07T10:00:00Z"}
{"type":"assistant_message","content":"...","timestamp":"2026-08-07T10:00:05Z"}
{"type":"run_finished","reason":"controller_done","timestamp":"2026-08-07T10:05:00Z"}
```

不需要复杂的 schema、version、migration。

### 6.3 Pi Controller 集成

**建议用法**：
```typescript
import { Agent } from "@earendil-works/pi-agent-core";

const controller = new Agent({
  model: "claude-opus-5",
  systemPrompt: `你是一个用户协作代理。
基于原始会话和当前 Agent 的输出，决定下一条用户输入。
如果任务已完成或无法继续，返回 DONE。`,
});

// 每次需要下一条用户输入时
const decision = await controller.run(
  `原始会话：${historicalTranscript}
当前 Agent 输出：${currentOutput}
下一步应该输入什么？如果任务完成，只回复 DONE。`
);

if (decision.includes("DONE")) {
  return { type: "done", reason: "controller判断任务完成" };
} else {
  return { type: "send", message: decision };
}
```

不需要复杂的 structured output、tool、session 管理。

### 6.4 错误处理

**原则**：让错误可见，不要隐藏。

**实现**：
- Agent 启动失败：记录错误，终止运行，报告中展示错误信息
- Turn timeout：记录 timeout 事件，继续运行（Controller 可能让 Agent 继续）
- Controller 失败：记录错误，终止运行
- Environment 准备失败：记录错误，终止运行

**不做**：
- 自动重试（可能掩盖问题）
- 降级策略（增加复杂度）
- 复杂的错误恢复（第一版不需要）

### 6.5 测试策略

**优先级**：
1. **端到端测试**：用真实历史会话运行，人工检查结果（最重要）
2. **单元测试**：状态机转换、事件序列化（次要）
3. **集成测试**：mock 的 Runner 和 Controller（可选）

**原因**：
- 端到端测试能发现真实问题
- 单元测试容易变成「测试实现细节」
- 这个项目的价值在于「是否帮助用户决策」，不在于「代码覆盖率」

## 7. 需要警惕的复杂度陷阱

### 7.1 不要变成通用 Agent 平台
**症状**：开始支持 Cursor、Windsurf、Cody...
**后果**：每个产品的适配器都要维护，核心被拖累
**建议**：第一年只支持 Claude Code，做好一个再说

### 7.2 不要过度设计 Controller
**症状**：Controller 开始有 memory、tool、multi-agent...
**后果**：Controller 本身变成一个复杂 Agent，难以调试
**建议**：Controller 只是一个 prompt，输入是上下文，输出是下一条消息

### 7.3 不要追求完美的环境恢复
**症状**：开始研究 Docker、VM、时间旅行调试...
**后果**：工程量巨大，大部分会话用不到
**建议**：承认「有些环境无法恢复」，诚实标记为 `observational`

### 7.4 不要建立评分系统
**症状**：开始设计「代码质量分」「用户满意度分」...
**后果**：分数不可信，用户不知道怎么解读
**建议**：展示事实（diff、时间、成本），让用户自己判断

### 7.5 不要追求实时性
**症状**：开始做 WebSocket、流式报告、进度条...
**后果**：增加复杂度，但价值有限（运行时间通常 5-30 分钟）
**建议**：第一版运行结束后生成报告即可

## 8. 关键决策（简化版）

### 8.1 TaskCase 保存什么？
**决策**：只保存引用 + 摘要

```ts
interface TaskCase {
  sessionPath: string;           // 原始会话路径
  initialMessage: string;        // 初始用户输入
  summary: string;               // 任务摘要（前 3 条消息）
  timestamp: string;
}
```

不保存完整 transcript，用时从 `sessionPath` 读取。

### 8.2 Controller 何时停止？
**决策**：三个条件之一满足时停止

1. Controller 返回 DONE
2. 达到预算（默认 30 分钟或 12 turns）
3. Target Agent 失败

不需要复杂的「无进展检测」「heartbeat」。

### 8.3 报告展示什么？
**决策**：四部分内容

1. 运行条件：模型、环境、时间
2. 客观指标：时间、token、成本、turn 数
3. 关键差异：第几轮开始不同，原始 vs 新运行的输出对比
4. 最终产物：diff、测试输出、最后一条消息

不需要「任务完成度」「代码质量」等主观评分。

### 8.4 如何处理闭源 Runtime？
**决策**：记录已知 + 标记未知

```ts
interface RuntimeInfo {
  product: "claude-code";
  version: string;              // 从 --version 读取
  knownConfig: {
    model: string;
    maxTokens?: number;
  };
  unknownFields: string[];      // 例如 ["systemPrompt", "tools"]
}
```

不试图反推、不假装知道、不隐藏不确定性。

## 9. 成功标准

第一版（3-4 周）完成后，应该能：

1. ✓ 用户指定一个历史 Claude Code 会话和一个目标模型
2. ✓ Harness 启动 Claude Code，通过 Pi Controller 模拟用户协作
3. ✓ 生成对比报告，包含时间、token、关键差异
4. ✓ 用户能根据报告判断「新模型是否更好」

**不需要**：
- 漂亮的 UI
- 自动发现会话
- 支持多个产品
- 复杂的证据选择
- 完美的环境恢复

**后续扩展时机**：
- 当有 10+ 真实使用案例后，根据实际痛点决定下一步
- 当有第二个 Runtime 实现需求时，再提取接口
- 当环境恢复成为主要问题时，再引入 Agent 推理

## 10. 参考：简洁项目的典范

以下项目虽然领域不同，但都展示了「理论清晰 + 代码克制」：

- **Pi Agent**：核心只有几个类，但能力完整
- **Promptfoo**：配置驱动，不过度抽象
- **SWE-bench**：简单脚本 + 清晰数据格式
- **Inspect AI**：可组合原语，不强制框架

这些项目的共同点：
- 能用函数解决的不用类
- 能用配置解决的不用代码
- 能用约定解决的不用抽象
- 核心文件数 < 20

## 11. 总结：保持简单的检查清单

在写每一个新功能前，问自己：

- [ ] 这个功能是否解决了一个真实的、已验证的问题？
- [ ] 有没有更简单的方式（配置、约定、手动）？
- [ ] 如果去掉这个功能，项目是否还能工作？
- [ ] 这个抽象是否至少有两个真实实现？
- [ ] 这个复杂度是否值得承受？

如果有任何一个答案是「不确定」，先不要做。

---

**最后的建议**：

先花 1 周写一个 200 行的原型，跑通一个真实会话。观察哪里卡住、哪里顺畅。然后再决定架构细节。

理论已经很好了，现在需要的是代码验证。不要让架构讨论变成无限细化，先做出来、用起来、再优化。
