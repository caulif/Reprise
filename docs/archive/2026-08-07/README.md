# 深度分析文档索引

> 归档说明：本目录保存 2026-08-07 阶段的分析、路线图和草稿，仅用于追溯。当前产品与架构规范请从 [文档首页](../../README.md) 开始阅读。

日期：2026-08-07

---

## 文档结构

本次深度分析产生了三份核心文档，分别从理论、实践和综合建议三个角度深入研究 Reprise 的设计。

### 📘 核心文档

#### 1. [Controller 设计深度分析](../../research/controller-foundations.md)
**关注点**：同等人类协作与 Controller 设计

**内容概要**：
- **理论基础**：5 个认知科学理论
  - Mixed-Initiative Interaction（主动权动态分配）
  - Grounding Theory（持续建立共同理解）
  - Scaffolding（恰好足够的帮助）
  - Joint Cognitive System（联合认知系统）
  - Supervisory Control（监督控制）

- **精炼模型**：
  - 四维能力边界：目标、领域、监督、授权
  - 三类介入动作：inform / correct / verify
  - 三层观察面：轨迹事实 / 用户可见产物 / 隐藏状态

- **实现边界**：
  - Controller 是什么、不是什么
  - 最小实现（只做 nextUserMessage）
  - 风险与限制

**适合阅读对象**：想深入理解 Controller 理论依据的开发者

---

#### 2. [架构设计深度分析](../../research/architecture-foundations.md)
**关注点**：项目整体架构设计与演进

**内容概要**：
- **架构理论基础**：6 个软件架构理论
  - Hexagonal Architecture（端口与适配器）
  - Anti-Corruption Layer（防腐层）
  - Modular Monolith（有边界的单体）
  - Event Sourcing（事件溯源）
  - Capability-Based Security（能力安全）
  - Evolutionary Architecture（演进式架构）

- **Pi Agent 设计哲学**：
  - 少量明确原语
  - 事件流驱动
  - 组合优先
  - 开发者控制

- **精炼架构模型**：
  - 薄的编排层（Orchestrator）
  - 三个核心端口（Runtime / Controller / Trace）
  - 可插拔适配器
  - 插件系统设计

- **防止架构腐化**：
  - Fitness Functions（自动化架构守护）
  - 与 Coding Agent 协作策略
  - 定期架构审查

- **与现有设计的对比**：
  - 保留的优点
  - 建议的简化
  - 实施路线图

**适合阅读对象**：想深入理解整体架构和实施策略的开发者

---

#### 3. [最终建议总结](./final-recommendations.md) ⭐ 推荐首读
**关注点**：整合两个分析，给出最终实施建议

**内容概要**：
- **两个核心关注点**：
  - 同等人类协作（Controller）
  - 会话环境恢复（Environment）

- **精炼的架构设计**：
  - 三个核心端口
  - 薄的编排层
  - 代码组织

- **防止架构腐化**：
  - Fitness Functions
  - 与 Coding Agent 协作

- **实施建议**：
  - 立即行动（本周）
  - 第一版实施（2-3 周）
  - 后续演进路径

- **与现有设计的对比**：
  - 保留什么
  - 简化什么
  - 新增什么

- **成功标准**：
  - 理论一致性
  - 实现简洁性
  - 可扩展性
  - 不易腐化

**适合阅读对象**：所有人，这是最全面的总结

---

## 阅读建议

### 快速了解（15 分钟）
→ 只读 [最终建议总结](./final-recommendations.md)

### 深入理解 Controller（30 分钟）
→ [Controller 设计深度分析](../../research/controller-foundations.md)

### 深入理解架构（40 分钟）
→ [架构设计深度分析](../../research/architecture-foundations.md)

### 完整阅读（90 分钟）
→ 按顺序阅读三份文档

---

## 关键洞察汇总

### Controller 设计

**核心观点**：
> Controller 不是通用人类模拟器，而是一个有固定能力边界的监督代理，基于联合认知系统理论。

**四维能力边界**：
- 目标能力：知道任务目标和验收标准
- 领域能力：掌握的事实、术语、偏好
- 监督能力：发现偏差和验证需求
- 授权能力：知道什么需要确认

**三类介入动作**：
- `inform`：补充缺失的事实
- `correct`：纠正偏离的方向
- `verify`：要求展示验证

**第一版简化**：
- 只实现 `nextUserMessage`
- 不实现 `proposeRecovery` 和 `selectEvidence`
- 基于 Pi Agent，保持简单

---

### 架构设计

**核心观点**：
> 架构应该是薄的编排层 + 可插拔适配器，保持两个关注点分离：环境恢复和人类协作。

**六个理论基础**：
1. Hexagonal Architecture - 依赖倒置
2. Anti-Corruption Layer - 防止污染
3. Modular Monolith - 清晰边界
4. Event Sourcing - 完整审计
5. Capability-Based Security - 最小权限
6. Evolutionary Architecture - 防止腐化

**三个核心端口**（第一版）：
```typescript
interface RuntimePort { ... }    // Target Agent 抽象
interface ControllerPort { ... } // 用户协作抽象
interface TracePort { ... }      // 事件存储抽象
```

**第一版简化**：
- 3 个端口（不是 4-5 个）
- 5 个状态（不是 11 个）
- 简单环境恢复（不用 Agent）
- 静态插件注册（不需要动态加载）

---

### 实施策略

**立即行动（本周）**：
1. 写 200 行原型验证核心假设
2. 定义 3 个 Port 接口
3. 创建目录结构

**第一版（2-3 周）**：
- Week 1: Core + ClaudeCodeAdapter
- Week 2: PiController + JsonlTrace
- Week 3: CLI + 真实会话测试

**交付标准**：
- 代码 < 1000 行
- 核心文件 < 10 个
- 通过所有 Fitness Functions
- 能对比真实会话

---

### 防止腐化

**Fitness Functions**（必须通过）：
```typescript
test('core should not depend on adapters')
test('RuntimePort has not changed unexpectedly')
test('TraceStore is append-only')
test('no file exceeds 300 lines')
```

**与 Coding Agent 协作**：
- 明确的架构规则 Prompt
- 提供正确和错误的示例
- 自动修复脚本
- CI 中集成架构测试

---

## 关键决策

### Controller

| 问题 | 决策 | 理由 |
|------|------|------|
| Controller 职责 | 只做 nextUserMessage | 验证核心价值，避免职责混乱 |
| 介入动作 | inform / correct / verify | 基于 Scaffolding 理论 |
| 观察面 | 三层可见性 | 轨迹事实 + 用户可见 - 隐藏状态 |
| 实现方式 | 基于 Pi Agent | 复用成熟框架，保持简单 |

### 架构

| 问题 | 决策 | 理由 |
|------|------|------|
| 架构模式 | Hexagonal + ACL | 依赖倒置，防止污染 |
| 端口数量 | 3 个（第一版） | 没有第二个实现时不抽象 |
| 状态数量 | 5 个（第一版） | 简化状态机，降低复杂度 |
| 事件存储 | Append-only JSONL | 完整审计，易于实现 |
| 插件系统 | 静态注册 + 契约测试 | 简单有效，类型安全 |
| 环境恢复 | 简单规则（第一版） | 验证需求后再引入复杂性 |

---

## 与原有文档的关系

### 原有设计文档
- `equivalent-human-collaboration.md` - Controller 理论基础
- `minimal-agent-harness-design.md` - 产品定义
- `architecture-discussion.md` - 架构讨论

### 本次分析的价值
1. **理论深化**：从 5 个理论深入推导 Controller 模型
2. **架构精炼**：从 6 个理论精炼出最小架构
3. **实施简化**：明确第一版范围和演进路径
4. **防腐化设计**：Fitness Functions 自动守护
5. **可操作性**：具体的代码示例和实施步骤

### 保留与优化
**保留**：
- ✓ 理论基础（Mixed-Initiative、Grounding、Scaffolding）
- ✓ 四维能力模型
- ✓ 三类介入动作
- ✓ 六边形架构
- ✓ 事件溯源

**优化**：
- 简化第一版端口数量（3 个）
- 简化状态机（5 个状态）
- 环境恢复从简单规则开始
- 添加 Fitness Functions
- 明确演进路径

---

## 文档地图

```text
原有设计文档/
├── equivalent-human-collaboration.md     # Controller 理论（v0.1）
├── minimal-agent-harness-design.md      # 产品定义（v0.3）
└── architecture-discussion.md           # 架构讨论（v0.2）

本次分析文档/
├── controller-deep-analysis.md          # Controller 深度分析 ⭐
├── architecture-deep-analysis.md        # 架构深度分析 ⭐
├── final-recommendations.md             # 最终建议总结 ⭐⭐⭐
└── README.md                            # 本文档（索引）

之前的分析/
├── optimization-recommendations.md      # 优化建议（克制版）
├── roadmap.md                           # 项目路线图
├── design-decisions.md                  # 设计决策记录
└── project-summary.md                   # 项目总结
```

---

## 下一步行动

### 本周
- [ ] 阅读 `final-recommendations.md`（所有人）
- [ ] 写 200 行原型验证 Controller（开发者）
- [ ] 定义 3 个 Port 接口（架构师）

### 下周
- [ ] 实现 ClaudeCodeAdapter
- [ ] 实现 PiControllerAdapter
- [ ] 实现 Orchestrator

### 第三周
- [ ] 实现 CLI
- [ ] 用真实会话测试
- [ ] 添加 Fitness Functions

---

## 联系与反馈

如有疑问或建议，请参考：
- Controller 设计问题 → `controller-deep-analysis.md`
- 架构设计问题 → `architecture-deep-analysis.md`
- 实施建议问题 → `final-recommendations.md`

**关键原则**：
- 理论驱动，不是直觉
- 克制优先，不是功能丰富
- 渐进演进，不是一次完美
- 自动守护，不是人工审查

---

*本文档由深度理论研究和实践分析生成，遵循 Pi Agent 的品味：少量明确原语、事件流、组合优先、避免宏大框架。*
