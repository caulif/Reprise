# Reprise 项目总结

状态：设计阶段审查
日期：2026-08-07

## 一句话总结

一个**克制的**、**理论驱动的**本地工具，用于回答：「在我的真实任务上，换个模型会不会更好？」

## 核心理念

### 问题定位
- **个人效用评估**，不是公共 benchmark
- **真实任务对照**，不是标准题库
- **可追溯报告**，不是单一分数

### 设计哲学
```text
理论清晰 > 功能丰富
代码简单 > 架构完美
事实优先 > 智能推理
删除优先 > 扩展优先
```

### 关键创新
**动态 Controller**：根据被测模型当前轨迹生成用户输入，而非逐字重放历史消息。

理论依据：Mixed-initiative interaction、Grounding、Scaffolding

## 设计优点（保持）

### ✓ 理论层面
- 问题定义清晰：个人效用 vs 公共排名
- 理论基础扎实：人机协作的认知科学研究
- 诚实的不确定性：`strict_match` / `observational` 分级
- 避免公平性幻觉：同等能力边界，不是相同文字

### ✓ 架构层面
- 六边形架构：核心与适配器隔离
- Anti-Corruption Layer：防止闭源产品污染
- Append-only trace：完整可追溯
- 控制平面与执行平面分离

### ✓ 工程层面
- 复用 Pi Agent Core，不重新造轮子
- 分阶段实施：验证 → 单会话 → 发现 → 改进
- 最小依赖：核心只依赖 Pi + 文件操作
- 删除优先：没有第二个实现时不创建接口

## 需要克制的地方（重点）

### 1. 不要过早抽象
❌ 第一版就建立 `RuntimePort` / `EnvironmentPort` / `registry`
✅ 只实现一个 Runtime (Claude Code) 和一个 Environment (Git)
✅ 有第二个实现时再提取接口

### 2. Controller 保持单一职责
❌ proposeRecovery + nextUserMessage + selectEvidence 三合一
✅ 第一版只做 `nextUserMessage`
✅ 环境恢复用简单规则（有 git commit 用 commit，否则 copy）
✅ 证据选择用固定规则（diff + 测试 + 最后消息）

### 3. 事件类型不要过度设计
❌ 十几种事件类型 + schema version + 归一化层
✅ 三种事件够用：`user_message` / `assistant_message` / `run_finished`
✅ 原始产品事件完整保存在 `raw/`，不急于归一化

### 4. Turn boundary 先用简单策略
❌ 三层信号（native / composite / heuristic）+ heartbeat + quiet period
✅ Claude Code 有 `turn.completed`，直接用
✅ 将来支持其他产品时再考虑 fallback

### 5. 状态机简化
❌ 11 个状态
✅ 5 个状态够用：`created` → `preparing` → `running` → `awaiting` → `finished`

## 第一版（9 周）范围

### M0: 核心假设验证 (1 周)
200 行脚本验证「动态 Controller 是否可行」

### M1: 单会话对照 (2-3 周)
```typescript
// 核心代码结构
src/
├── experiment.ts       # 状态机
├── claude-code.ts      # 启动 CLI + 解析事件
├── pi-controller.ts    # 生成下一条输入
├── trace.ts            # append-only 存储
├── report.ts           # 生成 Markdown
└── cli.ts              # 命令行入口
```

### M2: 环境隔离 (1-2 周)
简单规则：有 uncommitted changes 就 copy

### M3: 会话发现 (1-2 周)
扫描 `~/.claude/sessions/`，列出可选会话

### M4: 改进报告 (1 周)
并排对比 + 高亮差异 + HTML 报告

## 明确不做的功能

- ✗ 公共 benchmark 排行榜
- ✗ 统一质量评分
- ✗ 插件市场
- ✗ 云端服务
- ✗ 多个 Runtime (第一年只支持 Claude Code)
- ✗ 复杂的环境恢复（VM/Docker）
- ✗ 实时进度（运行结束后展示结果）
- ✗ 通用 Agent 平台

## 关键决策

| 问题 | 决策 | 理由 |
|------|------|------|
| Controller 能力 | 第一版只做 nextUserMessage | 避免职责混乱 |
| 环境恢复 | 简单规则：git commit 或 copy | 验证需求，渐进式 |
| 多 Runtime 支持 | 第一版只支持 Claude Code | 做好一个比十个浅尝辄止 |
| 质量评分 | 不做统一评分 | 任务异质，展示事实让用户判断 |
| 实验强度标记 | 四级：strict / version / environment / observational | 诚实，不假装完美复现 |
| 报告格式 | 先 Markdown，后 HTML | 快速验证内容价值 |
| Turn boundary | 优先原生事件 | 可靠且简单 |
| 事件存储 | Append-only JSONL | 可追溯、可恢复 |

完整决策记录见 `design-decisions.md`

## 风险与应对

| 风险 | 应对 |
|------|------|
| Controller 质量差 | M0 提前验证，调整 prompt |
| 环境恢复失败率高 | 诚实标记，不强求完美 |
| 功能范围蔓延 | 严格遵守「不做清单」 |
| 闭源 runtime 细节变化 | 保存 raw events，适配层解耦 |

## 成功标准（3 个月后）

### 定量指标
- 用户能在 10 分钟内完成一次对照实验
- 代码库 < 2000 行（不含依赖）
- 核心文件数 < 15
- 有 20+ 真实使用案例

### 定性指标
- 报告能帮助用户做出「是否换模型」的决策
- Controller 生成的用户输入被认为合理
- 代码易于理解和维护

### 不追求
- Star 数、下载量
- 支持所有 Agent 产品
- 100% 的环境复现率
- 漂亮的 UI

## 设计阶段的后续关注点

### 立即行动（1-2 周）
1. **协议定型**：把接口写成可编译的 TypeScript 定义
2. **契约测试设计**：为核心组件设计最小测试集
3. **Pi 集成方案**：确定如何用 Pi 实现 Controller

### 原型验证（1 周）
4. **200 行脚本**：验证核心假设（动态 Controller 是否可行）
5. **真实会话测试**：用 1-2 个历史会话检验
6. **人工评估**：Controller 生成的输入是否合理

### 第一版实施（2-3 周）
7. **单会话对照**：手动指定会话，生成对比报告
8. **人工验证**：用 3-5 个真实会话测试
9. **报告可用性**：是否帮助决策

### 关键问题验证
- Controller 生成的用户输入质量如何？
- Turn boundary 识别是否准确？
- 简单的环境恢复规则是否够用？
- 报告内容是否帮助用户决策？

## 保持简单的检查清单

在写每个新功能前，问自己：

- [ ] 这是否解决了一个真实的、已验证的问题？
- [ ] 有没有更简单的方式（配置、约定、手动）？
- [ ] 去掉这个功能，项目是否还能工作？
- [ ] 这个抽象是否至少有两个真实实现？
- [ ] 这个复杂度是否值得承受？

如果有任何一个答案是「不确定」，先不要做。

## 关键提醒

### 理论已经很好
- Mixed-initiative、Grounding、Scaffolding 支撑了动态输入设计
- `inform` / `correct` / `verify` 三分法有认知科学依据
- 四级实验强度分级诚实且实用

### 架构边界清晰
- 控制平面（Harness）vs 执行平面（Target Agent）
- 六边形架构 + Anti-Corruption Layer
- Append-only trace 支持可追溯性

### 现在需要的是代码验证
**不要让架构讨论变成无限细化。**

先做出来、用起来、再优化。

### 关键建议
**先花 1 周写一个 200 行的原型**，跑通一个真实会话。

观察哪里卡住、哪里顺畅。然后再决定架构细节。

## 文档地图

```text
项目理解：
├── equivalent-human-collaboration.md  # 理论基础（Controller 设计）
├── minimal-agent-harness-design.md   # 产品定义 v0.3
└── architecture-discussion.md         # 架构演化讨论

实施指南：
├── optimization-recommendations.md    # 优化建议（保持克制）⭐
├── roadmap.md                         # 项目路线图
├── design-decisions.md                # 设计决策记录（ADR）
└── project-summary.md                 # 本文档（总结）
```

**推荐阅读顺序**：
1. 本文档（快速理解项目）
2. `optimization-recommendations.md`（克制的实施建议）
3. `roadmap.md`（具体时间线）
4. `design-decisions.md`（理解为什么这样设计）

## 最后的话

这是一个有野心但克制的项目：

- **有野心**：解决真实问题，有扎实理论基础
- **克制**：不追求大而全，聚焦核心价值

关键是：**保持简单，快速验证，根据实际使用反馈迭代。**

不要被「完美架构」拖累。先做出能用的版本，让真实用户告诉你什么重要。

---

**下一步**：写 200 行原型，验证核心假设。
