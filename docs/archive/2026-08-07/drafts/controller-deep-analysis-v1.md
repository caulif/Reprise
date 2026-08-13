# Controller 设计深度分析：理论、实证与设计依据

状态：深度分析 v1.3（理论基线；以文末 Canonical v1 为准）
日期：2026-08-07

---

## 摘要

本文档基于认知科学、人机交互、分布式认知理论以及真实人-Agent 协作研究，解释 Reprise 为什么需要 Controller，以及“同等人类能力”应如何理解。Canonical 结论是：**Controller 是一个受原始会话证据约束、代表特定用户协作能力的监督控制器**。它不是理想专家或句子模仿器；工程接口、生命周期和观察适配器见配套的《同等人类协作与 Controller 设计》。

**核心发现**（基于真实 Claude Code 使用数据）：
- 用户平均承担 70% 的规划决策，Agent 承担 80% 的执行决策
- 专家每提示获得 2 倍动作量、5 倍输出量，验证成功率是新手的 2 倍
- 领域专业知识（而非编码能力）是成功协作的关键驱动因素
- 当前人-Agent 协作仍以简单监督模式为主（81%），真正的双向协作模式不足 20%

---

## 1. 理论基础与真实协作现状

### 1.0 真实世界的人-Agent 协作研究综述

在深入理论之前，我们先审视**真实世界的协作现状**。基于 Anthropic 对约 40 万次 Claude Code 会话的分析、CowCorpus 关于 Web Agent 协作的研究、以及 Frontiers in Computer Science 对 105 项实证研究的系统综述，我们发现：

#### 1.0.1 协作的实际分工模式

**Claude Code 使用数据揭示的分工**：
- **用户负责"做什么"（规划决策）**：平均承担约 70% 的规划决策
- **Agent 负责"怎么做"（执行决策）**：平均承担约 80% 的执行决策
- 典型会话包含约 4 个回合，每个用户提示触发约 10 个 Agent 动作
- Agent 每回合平均输出 2,400 词

**关键发现**：当用户保留执行控制权（>80% 执行决策）时，Agent 约执行 8 个动作；当 Agent 掌控规划（>80% 规划决策）时，动作数升至约 16 个。这表明**控制权的分配直接影响自主性范围**。

#### 1.0.2 专家与新手的协作差异

**工作量差异**：
- 新手会话：每提示约 5 个动作，约 600 词输出
- 专家会话：每提示约 12 个动作，约 3,200 词输出（2 倍动作量，5 倍输出量）

**成功率差异**：
- 验证成功率：新手 15%，中级及以上 28-33%
- 部分成功率：新手 77%，中级及以上 91-92%
- 遇到困难时的放弃率：新手 19%，其他人 5-7%

**核心洞察**："大部分收益集中在专业知识尺度的低端——新手到中级的跨越大于中级到专家的跨越"。这表明**领域能力的基本掌握即可捕获大部分价值**，深度专业化只带来少量额外收益。

#### 1.0.3 四种真实协作模式（来自 Web Agent 研究）

基于 CowCorpus 数据集的聚类分析，真实用户呈现四种系统性差异的协作风格：

| 模式 | 干预频率 | 控制权交还率 | 干预时机 | 典型行为 |
|------|----------|--------------|----------|----------|
| **Hands-off（放手型）** | 极低 | - | 全程观察 | Agent 端到端执行，用户很少介入 |
| **Collaborative（协作型）** | 中等 | 高 | 较早 | 选择性干预，短暂介入后交还控制权 |
| **Hands-on（监督型）** | 高 | 中 | 较晚但持续 | 频繁且高强度干预，与 Agent 持续交替 |
| **Takeover（接管型）** | 低 | 低 | 任务后期 | 一旦接手就保持控制，倾向自己完成 |

**关键启示**：用户有**系统性差异的协作偏好**，不存在"一刀切"的最优干预策略。Controller 设计应适配不同协作风格。

#### 1.0.3a 本机真实 Codex 会话的补充观察

对本机 `C:\Users\15893\.codex\sessions` 和 `history.jsonl` 中可读的用户消息做了结构性抽样。这里的目的不是把个人会话当作统计学样本，而是检查“真实输入到底长什么样”。观察到的输入不只有纠错和验证，还大量包含：

- **继续推进**：`继续`、`接着做`、`开始`、`照这个方案做`；
- **确认方向后放权**：`可以`、`同意`、`按你的推荐来`；
- **提供新上下文**：补充路径、错误日志、目标、偏好或验收要求；
- **要求重新思考**：`再思考一下`、`这个不对`、`结合项目实际重新分析`；
- **要求产出或落地**：`更新文档`、`直接修改`、`运行测试`；
- **澄清或收窄范围**：纠正任务边界、否定不需要的功能。

因此，“继续”不是 `wait` 的同义词。`wait` 表示 Agent 仍在运行，Harness 不发送输入；`continue` 表示上一轮已经到达输入边界，Controller 代表用户明确允许 Agent 继续。真实会话中，这两者是不同事件。

该观察只用于校正设计，不证明这些短语的普遍频率。它支持一个更朴素的结论：Controller 首先要能生成**自然、短、可执行的下一条用户消息**，而不是先输出一套用户心理学标签。

#### 1.0.4 当前协作的深度不足

Frontiers in Computer Science 对 105 项实证研究的元分析发现：

- **81% 的交互属于简单监督模式**（AI-first 或 AI-follow），人类仅仅监督 AI 输出
- **真正的双向协作模式不足 20%**：涉及交互式调整、对话引导或战略性委派的模式极少
- 论文标题直言："人-AI 协作还不够协作"（Human-AI collaboration is not very collaborative yet）

**对 Controller 的启示**：当前大多数 Agent 系统仍停留在"Agent 提议 → 用户批准/拒绝"的简单循环，真正的**协商、共同构建、渐进澄清**等深度协作模式尚未充分实现。

#### 1.0.5 信任校准的挑战

AI 置信度校准研究（arXiv 2402.07632）揭示了两个关键问题：

**过度自信的 AI**：
- 表达的置信度超过实际准确率（如显示 90% 但实际只有 70%）
- 导致**误用**（misuse）：用户在 AI 错误时仍采纳建议
- 实验数据：显著增加误用率，降低协作效果

**不自信的 AI**：
- 表达的置信度低于实际准确率（如显示 70% 但实际达到 90%）
- 导致**弃用**（disuse）：用户在 AI 正确时拒绝采纳
- 实验数据：显著增加弃用率，同样损害协作成果

**悖论**：增加透明度（明确告知 AI 置信度未校准）虽能帮助用户识别问题，但也导致对 AI 预测能力的不信任扩散，"即使 AI 准确率未变，信任也下降"。研究结论："信任校准支持不能改善人-AI 协作结果"。

**对 Controller 的启示**：单纯的透明度不够，需要在帮助用户正确理解置信度的同时，维持对 AI 能力的适当信任。

---

### 1.1 Mixed-Initiative Interaction：主动权的动态分配

[Eric Horvitz 的开创性研究](https://dl.acm.org/doi/10.1145/302979.303030)提出，有效的人机协作不是固定的"人指挥机器"或"机器自动化"，而是**主动权在人与系统之间动态流转**。

**核心洞察**：
- 主动权不是二元的（人控制 vs 机器控制），而是连续可调的
- 系统应根据当前状态的不确定性、风险、成本决定谁取得主动权
- 用户介入不是"打断自动化"，而是协作的自然组成部分

**对 Controller 的启示**：
```text
运行时只需要回答两个问题：
1. Agent 仍在运行吗？
2. 到达输入边界后，用户下一条会说什么？

wait      # Agent 仍在运行，不发送输入
continue  # 到达输入边界，正常推进
send      # 到达输入边界，需要补充、纠正、验证或确认
```

这解释了为什么**不同模型的干预次数可以不同**：更强的模型需要更少的帮助，这是能力差异的自然体现，不是"不公平"。

**与真实协作数据的对应**：
- Claude Code 数据显示专家用户每提示触发 12 个动作（新手仅 5 个），验证了"能力差异 → 干预差异"的合理性
- 四种协作风格（Hands-off/Collaborative/Hands-on/Takeover）体现了主动权分配的个性化差异
- 真实用户平均承担 70% 规划决策，证明主动权**不是零和博弈**而是分层分配：用户主导目标，Agent 主导执行

---

### 1.2 Grounding Theory：持续建立共同理解

[Clark 与 Brennan (1991)](https://psycnet.apa.org/record/1991-97605-006) 的 Grounding 理论强调：**沟通是一个持续建立共同认知（common ground）的过程**。

**核心洞察**：
- Common ground 不是静态的"已知事实集合"，而是动态更新的
- 每次对话都在测试和更新共同理解
- 历史消息只说明**过去**的共同认知，不能直接套用到新的状态

**对 Controller 的启示**：

原始会话：
```text
User: "修复登录 bug"
Agent: [改了 auth.ts]
User: "测试一下"              # 这条消息是针对原模型已经改了 auth.ts 的状态
```

候选模型走到不同状态：
```text
User: "修复登录 bug"
Agent: [改了 login.ts，但漏了 auth.ts]
Controller: ???               # 不能直接说"测试一下"，因为共同认知已经不同
```

**Controller 必须重新评估当前的共同认知**：
- Agent 是否理解了任务目标？
- Agent 的当前方向是否偏离？
- Agent 是否需要补充信息？

不能把历史消息当成永远有效的脚本。

**与真实协作数据的对应**：
- Web Agent 研究发现用户干预的三大动机：**错误纠正**（Agent 选错元素、过早执行）、**偏好未对齐**（忽略价格/地点等先决条件）、**辅助性干预**（复杂 UI、资源缺失）
- 这三类动机都源于 Agent 与用户之间的**共同认知缺失**：Agent 不知道用户真正在乎什么（偏好）、不理解环境复杂性（辅助需求）、或误解了任务目标（错误纠正）
- Controller 必须**动态重建共同认知**，而非假设历史消息已建立永久的共识

---

### 1.3 Scaffolding：恰好足够的帮助

[Wood, Bruner & Ross (1976)](https://acamh.onlinelibrary.wiley.com/doi/10.1111/j.1469-7610.1976.tb00381.x) 提出的 Scaffolding 理论描述：**根据学习者当前能力，提供恰好足够的支持，并在其能自主完成时撤除**。

这与 Vygotsky 的 **Zone of Proximal Development (ZPD)** 紧密相关：
- ZPD 是"独立完成"和"协助下完成"之间的区域
- 有效支持发生在这个区域内
- 支持不是越多越好，而是恰好填补能力差距

**对 Controller 的启示**：

Controller 的目标不是：
- ✗ 最大化干预次数（过度支持）
- ✗ 替 Agent 完成任务（剥夺自主性）
- ✗ 统一的帮助策略（忽视能力差异）

Controller 的目标是：
- ✓ 恢复"用户会提供的帮助边界"
- ✓ 让 Agent 在 ZPD 内工作
- ✓ 在 Agent 能自主完成时 `wait`

**Scaffolding 的三个维度**：

| 维度 | 含义 | Controller 体现 |
|------|------|------------------|
| **Recruitment** | 吸引注意到关键特征 | `inform`：补充 Agent 未注意的事实 |
| **Direction maintenance** | 保持目标方向 | `correct`：纠正偏离的方向 |
| **Demonstration** | 展示解决路径 | `verify`：要求 Agent 展示验证过程 |

**与真实协作数据的对应**：
- **专家的帮助更有效**：Claude Code 数据显示，专家在遇到困难后的验证成功率为 15%（新手仅 4%），证明专家的 scaffolding 更精准
- **新手更易放弃**：新手遇到阻碍时放弃率 19% vs 其他人 5-7%，说明**恰当的 scaffolding 能防止过早放弃**
- **帮助的边界是动态的**：专家触发 2 倍动作量、5 倍输出量，说明有效的 scaffolding 不是固定剂量，而是**根据 Agent 能力调整支持强度**

---

### 1.4 Joint Cognitive System：联合认知系统

[Hollnagel & Woods (2005)](https://www.taylorfrancis.com/books/mono/10.1201/9781420038194/joint-cognitive-systems-erik-hollnagel-david-woods) 提出：**人和自动化系统不是两个独立实体，而是一个联合认知系统**。

[Distributed Cognition 理论](https://www.sciencedirect.com/science/article/pii/S0747563224000134)进一步强调：**认知不只在头脑中，而是分布在人、工具、环境中**。

**对 Harness 的启示**：

被测对象不是"模型"，而是联合认知系统：
```text
联合认知系统 = 用户能力
                + Controller
                + Agent Runtime
                + 目标模型
                + 工具
                + 环境状态
```

**关键推论**：

1. **只看 Agent 文本输出是不够的**
   - Agent 说"完成了"不等于真的完成
   - 需要观察环境状态：diff、测试输出、文件变化

2. **Controller 需要观察面，但不能有执行权**
   - 观察：文件变化、测试结果、工具调用
   - 不执行：不替 Agent 修改文件、不运行命令

3. **验证是协作动作，不是事后评分**
   - 用户不是在 Agent 完成后打分
   - 用户在过程中要求 Agent 验证："请运行测试"

**与真实协作数据的对应**：
- **领域知识是关键驱动因素**：Anthropic 研究发现"编码 agent 不是在替代领域专业知识——工作者带给 agent 的理解越多，agent 能做的高质量工作就越多"
- **职业无关的能力评估**：所有主要职业在验证成功率上都在软件工程师的 7 个百分点以内，说明**任务特定的领域能力**比职业标签更重要
- **认知分布在多个层级**：Claude Code 数据显示用户承担 70% 规划决策、Agent 承担 80% 执行决策，验证了认知确实**分布在不同角色和不同抽象层次**

---

### 1.5 Supervisory Control：监督控制

[Parasuraman, Sheridan & Wickens (2000)](https://ieeexplore.ieee.org/document/844354) 的监督控制模型描述：**监督者观察系统状态，正常时放手，偏离时介入**。

**Levels of Automation**：

| Level | 描述 | Controller 的对应 |
|-------|------|-------------------|
| **Monitoring** | 系统自主执行，人类观察 | `wait` |
| **Exception handling** | 系统遇到异常时请求帮助 | Agent 声称完成但证据不足 → `verify` |
| **Shared control** | 人类和系统协商决策 | Agent 方向偏离 → `correct` |
| **Management by consent** | 系统提出方案，人类批准 | Agent 需要领域事实 → `inform` |

**Controller 的循环**：
```text
观察当前状态
  ├── Agent 仍在运行？ → wait
  ├── 已到输入边界且正常推进？ → continue
  ├── 缺少原始会话中已明确的信息？ → inform
  ├── 方向偏离？ → correct
  ├── 证据不足？ → verify
  └── 多个方向且偏好未知？ → clarify
```

**与真实协作数据的对应**：
- **四种协作风格映射到监督强度**：
  - Hands-off 用户较少发送输入
  - Collaborative 用户在正常推进和关键节点选择性发送输入
  - Hands-on 用户更频繁地补充和纠正
  - Takeover 用户在后期更可能要求停止自动推进或重新收窄范围

这些只是观察标签，不作为第一版运行时分类器。
- **干预时机的预测价值**：Web Agent 研究提出 Perfect Timing Score (PTS) 指标，强调"时机比二元分类更关键"——过早或过晚的干预都降低效果
- **主动请求帮助的缺失**：当前 Agent 瓶颈是时间需求（Agent 平均 93.1 秒 vs 人类 23.9 秒），未来应加入"不确定性估计机制以识别用户输入最有价值的决策点"

---

### 1.6 真实世界协作的五大启示

综合上述理论和实证研究，我们提炼出五条关键启示：

#### 1. 以原始会话证据适配，而不是构建用户分类器

不同用户有系统性差异的协作偏好，但本项目不需要把用户硬分类。Controller 应：
- 使用原始会话中的表达方式、目标、约束和已知事实；
- 让当前 Agent 的实际表现决定下一条输入；
- 不把协作风格转换成复杂阈值、分数或长期画像。

#### 2. 领域能力边界比通用能力更关键

Claude Code 研究发现：
- 领域知识（而非编码能力）是成功的关键驱动因素
- 新手到中级的跨越大于中级到专家的跨越
- 所有职业在成功率上接近，说明任务特定能力比职业标签重要

Controller 应：
- 从原始会话提取**任务特定的领域知识**（术语、约束、验收标准）
- 不依赖用户的职业或技术背景作为能力代理
- 不推断原始会话没有表达的偏好

#### 3. 真实协作不只有“纠错”

真实会话还包含大量正常推进消息。对本机 Codex 会话的补充观察显示，`继续`、`接着做`、`开始`、`按这个方案做`、`可以`等短消息是常见的人类输入。Controller 第一版应：
- 把**正常推进**作为一类一等输入意图；
- 只在 Agent 到达输入边界时发送推进消息，Agent 仍在运行时不插话；
- 保留 inform/correct/verify/clarify 处理信息补充、方向纠正、验证和真正的不确定性；
- 不把研究中的协作分类和统计比例硬编码为运行时规则。

#### 4. 透明度需要与信任维护平衡

AI 置信度研究揭示的悖论：增加透明度虽能帮助识别问题，但也导致信任扩散。Controller 应：
- 在 trace 中记录本次输入、触发原因和引用的当前上下文（透明度）
- 但**不输出 Agent 的"能力评分"或"可信度百分比"**（避免不当信任校准）
- 报告展示可读的上下文和事实，不要求 Controller 生成复杂的解释对象

#### 5. 验证机制是协作的组成部分

真实协作中，验证不是事后评估，而是过程中的关键节点：
- 用户要求 Agent 运行测试、展示效果、列出改动
- Claude Code 研究使用的验证标准（Git 活动、测试通过、用户确认）都是**环境的硬信号**

Controller 应：
- 只在验证结果会影响任务验收或风险判断时使用 `verify`
- 观察面按 runtime 已有能力提供**可验证产物**（diff、测试输出、截图）
- 不替 Agent 执行验证，但可以要求 Agent 展示验证过程
- 已有充分证据时不要重复要求验证

---

## 2. 精炼的 Controller 模型

### 2.1 设计定位：受证据约束的“下一条用户输入”

本项目要模拟的不是“知道真实用户全部想法”的用户，也不是理想化的任务评审员，而是：

> **只使用原始会话中当时已经可获得的信息，结合当前被测 Agent 的输入和输出，生成用户此刻最可能发送的下一条消息。**

模型可以根据当前 Agent 的不同表现生成不同输入；它不应无条件重放原始会话的后续消息。原始会话提供的是用户目标、表达习惯、约束和事实证据，不是固定脚本。

Controller 的核心流程只有两步：

```text
观察当前 Agent 状态 → 需要输入时生成下一条用户消息
```

不要在第一版引入“用户策略状态机”“协作风格分类器”“能力评分器”等运行时抽象。它们可以作为后续研究的分析标签，但不是 Controller 必需的输入。

### 2.2 五类实际用户消息意图

真实会话中的用户消息可先用五类足够直观的意图覆盖。意图只是生成消息前的内部提示，最终仍输出普通用户文本。

| 意图 | 什么时候用 | 例子 |
|------|------------|------|
| **continue** | Agent 正常推进、上一轮已结束或等待输入 | “继续”“接着做”“按这个方案继续” |
| **inform** | 当前 Agent 缺少原始会话中用户已明确提供的事实、偏好或约束 | “目标是兼容 Node 18，不要改公共 API” |
| **correct** | Agent 的目标理解、计划或改动明显偏离原任务 | “我不是要重写，只修复这个状态丢失问题” |
| **verify** | 高风险结果或完成声明缺少支持验收的证据 | “请运行相关测试，并说明覆盖了哪些场景” |
| **clarify** | 原始会话没有足够证据，当前存在多个合理方向，不能替用户编造偏好 | “这里有两个方案，请让用户确认优先兼容还是迁移” |

`continue` 是新增且必要的意图。它与 `wait` 的区别是：

- `wait`：Agent 仍在运行，Controller 不发送任何消息；
- `continue`：Agent 已到达下一轮输入边界，Controller 发送一句简短的推进消息。

第一版不要求 Controller 输出 `authorize`、`complete`、`blocked` 等复杂决策类型。高风险操作是否允许、Agent 是否真的结束，优先由 Harness、runtime 和用户确认机制处理；Controller 只在需要时通过 `verify` 或 `clarify` 生成普通消息。Controller 可以在 trace 中记录“为什么发送”，但不必把这些原因设计成 runtime 必须理解的协议。

### 2.3 最小决策顺序

Controller 只需要按下面的顺序判断：

```text
1. Agent 还在运行？
   → wait（不发消息）
2. Agent 已到输入边界且没有明显问题？
   → continue（发“继续”或同等自然表达）
3. 是否缺少原始会话中已经明确的关键事实？
   → inform
4. 是否已经偏离目标或约束？
   → correct
5. 是否缺少完成所需的关键证据？
   → verify
6. 是否存在多个合理方向且用户偏好未知？
   → clarify
7. 任务确实结束或无法继续？
   → 由 Harness 结束，不生成伪造的用户消息
```

实际生成时，如果多个条件同时成立，选择最能改变下一步行为的一项：通常是 `correct` 优先于 `inform`，`clarify` 优先于猜测，`verify` 只在证据会影响验收时使用。

## 3. 观察面：只提供 Agent 已经可能看到的上下文

Controller 需要知道当前 Agent 做到了哪一步，但不应拥有第二个执行环境。第一版只提供能被 LLM 直接理解的摘要，不把理论术语转成复杂协议。

| 内容 | Controller 可见性 | 说明 |
|---|---|---|
| 原始任务与历史用户消息 | 提供 | 提取目标、约束和用户表达方式 |
| 当前 Agent 输入、输出和工具结果 | 提供 | 这是生成下一条消息的主要依据 |
| 当前轮次是否仍在运行、是否等待输入 | 提供 | 区分 `wait` 与 `continue` |
| 改动文件、diff 摘要、测试结果、截图 | 按现有 runtime 能力提供 | 只作为 Agent 已产生的可见证据 |
| 未展示文件、密钥、后台数据库、任意 shell | 不提供 | Controller 不应获得超出用户/Agent 的隐含能力 |

### 3.1 ObservationBundle：第一版够用的结构

```typescript
type ObservationBundle = {
  originalTask: string;
  originalUserMessages: string[];
  currentAgentInput: string;
  currentAgentOutput: string;
  recentToolResults?: string[];
  changedArtifacts?: string[];
  checks?: string[];
  waitingForUser: boolean;
  turn: number;
};
```

字段可以由 adapter 从原生事件中组装。不要为了实现 Controller 新建独立的 User Model、Evidence Graph 或长期画像系统。若后续确有评估需要，再从已有 trace 派生这些分析数据。

## 4. Controller 的实现边界

### 4.1 Controller 是什么

Controller 是 Harness 中的一个很薄的适配层：

```text
原始会话 + 当前 Agent 轨迹 + 简单系统提示
                    ↓
             下一条用户消息或空
```

它可以用一个 LLM 调用实现，输出普通用户文本。为便于调试，调用结果可以在 trace 中额外记录意图和原因，但这些不是必须暴露给 runtime 的复杂控制协议。

推荐的端口仍然只有：

```typescript
interface ControllerPort {
  nextUserMessage(observation: ObservationBundle): Promise<string | null>;
}
```

- 返回 `null`：不发送消息；如果 Agent 仍在运行，就是 `wait`；如果已到输入边界，则由 Harness 决定是否再次调用；
- 返回文本：把文本作为用户下一轮输入发送给 Agent；文本可以是“继续”，也可以是补充、纠正或验证要求。

### 4.2 Controller 不是什么

- 不是第二个 Target Agent，不修改文件、不运行命令；
- 不是完整用户模拟器，不猜测原始会话未表达的偏好；
- 不是固定脚本回放器，不机械复制历史后续消息；
- 不是质量评分器，不输出统一分数或置信度百分比；
- 不是任务执行器，不自己修复 Agent 的错误；
- 不是复杂的多代理协商系统，不要求 runtime 支持抽象的协作协议。

### 4.3 Agent 友好的最小 System Prompt

Controller 的提示词应使用 Agent 能直接理解的工作语言，而不是要求模型先掌握 Mixed-Initiative、ZPD、Joint Cognitive System 等理论。理论只用于设计文档和人工评估，不放进运行时指令。

```markdown
你要模拟原始会话中的用户，给当前被测 Agent 发送下一条真实用户消息。

只使用原始会话中在当前时点已经出现的信息。不要机械复制原始会话的后续消息，
因为当前 Agent 的表现可能不同。根据当前 Agent 的输入、输出和工具结果，判断用户现在会怎么回复。

优先输出一条简短、自然、能推动任务的用户消息：
- Agent 正常完成当前步骤或等待下一步：输出“继续”或同等自然表达；
- 缺少用户已经明确说过的事实、约束或偏好：补充它；
- 方向明显错误：直接纠正；
- 结果重要但缺少测试、截图、diff 等证据：要求验证；
- 有多个合理方案且原始会话没有偏好：请求用户确认，不要猜。

如果没有必要发送消息，输出空字符串。
不要修改文件，不要运行工具，不要输出分析、评分或置信度，只输出下一条用户消息。
```

这个提示词保留了五类行为，但只要求 LLM 做一件事：**生成下一条消息**。

## 5. 风险与限制

### 5.1 已知风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **Controller 能力过强** | 中 | 高 | 固定版本和配置，记录每次决策和理由 |
| **Controller 能力过弱** | 中 | 中 | 允许用户补充任务上下文，但对所有候选保持同一配置 |
| **不同候选获得不一致帮助** | 高 | 中 | 记录 intent 和 reason，供事后分析 |
| **Controller 本身的推理失败** | 中 | 高 | 记录原始观察和决策，可人工审查 |

### 5.2 诚实的限制

Controller 不能解决：
- **完美公平**：Controller 本身是模型，有随机性和偏见
- **完整信息**：原始会话可能缺失用户当时的隐含知识
- **普适策略**：不同用户、不同任务需要不同的协作风格

**应对**：
- 报告中明确记录 Controller 的模型、版本、配置
- 展示每次决策的 intent、reason、evidence
- 让用户看到 Controller 的决策过程，不只是最终结果
- 不把单次运行结果宣传成普遍结论

**来自真实协作研究的额外限制认知**：
- **个性化差异无法完全捕获**：四种协作风格（Hands-off/Collaborative/Hands-on/Takeover）来自聚类分析，但单个用户可能处于光谱中间或情境依赖
- **专业知识难以从文本推断**：研究通过用户指令精确度、验证要求、纠正方向来评估专业知识，但这些信号在短会话中可能不明显
- **信任校准的悖论**：增加透明度可能降低信任，Controller 无法独立解决这一矛盾
- **深度协作模式尚未成熟**：当前技术下，真正的双向协商、共同构建、渐进澄清等模式仍在探索中

---

## 6. 成功的 Controller 设计标准

### 6.1 理论一致性

- ✓ 理论用于解释边界和取舍，不直接变成运行时协议
- ✓ 设计决策与真实协作数据对齐（Claude Code 使用研究、Web Agent 协作模式、人-AI 交互元分析）
- ✓ 以“原始会话证据 + 当前 Agent 轨迹 → 下一条用户输入”为核心链条

### 6.2 实现简洁性

- ✓ 核心调用是一个函数：`ObservationBundle → string | null`
- ✓ 不需要复杂的规则引擎、状态机、多 Agent 协商
- ✓ 意图只作为 LLM 提示中的简单检查清单，不要求结构化协议
- ✓ 遵循 Anthropic 的 agent 构建原则：简洁性、透明性、工具优先

### 6.3 可观察性

- ✓ 每次决策记录 intent、reason、evidence
- ✓ 观察面是声明式的、版本化的
- ✓ 用户可以追溯"为什么 Controller 在这里介入"
- ✓ 避免数字化评分（不输出"能力 8.5 分"或"可信度 75%"），保持叙事性解释

### 6.4 可验证性

- ✓ 用真实历史会话测试 Controller 质量
- ✓ 人工评估：生成的用户输入是否合理
- ✓ 与基线对比：逐字重放 vs 动态 Controller
- ✓ 使用 Claude Code 研究的验证标准作为参考（Git 活动、测试通过、用户明确确认）

### 6.5 适配性（新增标准）

基于真实协作研究，增加适配性标准：
- ✓ 使用原始会话中的目标、事实、约束和表达方式
- ✓ 依据当前 Agent 表现动态生成输入，而不是固定回放
- ✓ “继续”与“等待”边界清楚，避免无意义插话
- ✓ 不把用户风格、能力或信任转换成复杂的运行时分数

---

## 7. 与现有设计的关系

### 7.1 保留的设计

当前 `equivalent-human-collaboration.md` 的核心已经很好：

- ✓ “同等用户输入能力，不是相同文字”
- ✓ 原始会话作为证据，当前 Agent 表现决定下一条输入
- ✓ continue / inform / correct / verify / clarify 五类简单意图
- ✓ ObservationBundle 的最小观察面设计
- ✓ 只读观察、不执行的边界

### 7.2 建议优化

1. **简化第一版范围**
   - Controller 第一版只做 `nextUserMessage`
   - `proposeRecovery` 和 `selectEvidence` 暂用简单规则

2. **明确理论链条**
   - 每个设计决策都应能追溯到一个理论依据
   - 避免"我觉得应该这样"的设计

3. **可观察性优先**
   - 每次决策记录完整上下文
   - 报告中展示 Controller 的决策轨迹

4. **验证优先**
   - 用真实会话测试 Controller
   - 人工评估生成的用户输入质量

---

## 8. 参考文献

### 核心理论
- Horvitz, E. (1999). [Principles of Mixed-Initiative User Interfaces](https://dl.acm.org/doi/10.1145/302979.303030)
- Clark, H. H., & Brennan, S. E. (1991). [Grounding in Communication](https://psycnet.apa.org/record/1991-97605-006)
- Wood, D., Bruner, J. S., & Ross, G. (1976). [The Role of Tutoring in Problem Solving](https://acamh.onlinelibrary.wiley.com/doi/10.1111/j.1469-7610.1976.tb00381.x)
- Hollnagel, E., & Woods, D. D. (2005). [Joint Cognitive Systems](https://www.taylorfrancis.com/books/mono/10.1201/9781420038194/joint-cognitive-systems-erik-hollnagel-david-woods)
- Parasuraman, R., Sheridan, T. B., & Wickens, C. D. (2000). [A Model for Types and Levels of Human Interaction with Automation](https://ieeexplore.ieee.org/document/844354)

### 真实协作研究（新增）
- **Anthropic (2026)**. [Agentic coding and persistent returns to expertise](https://www.anthropic.com/research/claude-code-expertise) - 基于约 40 万次 Claude Code 会话的实证分析
- **Lv et al. (2025)**. [Understanding Human Intervention in Web Agents](https://arxiv.org/html/2602.17588) - CowCorpus 数据集，四种协作模式（Hands-off/Collaborative/Hands-on/Takeover）
- **Yigit et al. (2024)**. [Human-AI Collaboration is Not Very Collaborative Yet](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2024.1521066/full) - 105 项实证研究的元分析
- **Li et al. (2024)**. [Does Confidence Calibration Help Human-AI Collaboration?](https://arxiv.org/html/2402.07632v2) - 置信度校准对信任的悖论性影响
- **Anthropic (2024)**. [Building effective agents](https://www.anthropic.com/research/building-effective-agents) - Agent 系统设计的最佳实践

### 扩展阅读
- [Distributed Cognition Theory](https://www.sciencedirect.com/science/article/pii/S0747563224000134)
- [Zone of Proximal Development (Vygotsky)](https://www.simplypsychology.org/Zone-of-Proximal-Development.html)
- [Google PAIR Guidelines](https://pair.withgoogle.com/guidebook/) - 人机协作设计原则
- [Human-AI Joint Cognitive Systems](https://www.frontiersin.org/journals/psychology)
- [Adjustable Autonomy in Human-Robot Interaction](https://ieeexplore.ieee.org/document/1545655)

---

## 附录：Controller System Prompt 草案

```markdown
你要模拟原始会话中的用户，给当前被测 Agent 发送下一条真实用户消息。

原始会话是参考，不是固定脚本。只使用当前时点已经出现的信息；当前 Agent 的表现不同，
你就应生成不同的用户输入。你的目标是帮助任务继续完成，但不能替用户编造未表达的偏好。

根据当前 Agent 状态选择最自然的回复：
1. 正常推进或等待输入：输出“继续”或类似短消息；
2. 缺少原始会话中已明确的事实、约束或偏好：补充信息；
3. 方向明显偏离目标：纠正方向；
4. 重要结果缺少必要证据：要求测试、展示结果或列出改动；
5. 有多个合理方向且没有用户偏好：请求确认；
6. 没有必要发送消息：输出空字符串。

只输出用户要发送的消息，不要输出标签、理由、评分、置信度或工具调用。
```

## 结论

本项目最终采用一个**简单、证据受限、Agent 友好的 Controller**：

- **核心目标**：根据原始会话和当前被测 Agent 轨迹，生成下一条用户输入；
- **正常推进**：明确支持 `continue`，例如“继续”“接着做”；
- **异常介入**：支持 `inform / correct / verify / clarify`；
- **执行边界**：Controller 不修改文件、不运行工具、不访问隐藏环境；
- **实现接口**：第一版只保留 `nextUserMessage`，返回一条文本或 `null`；
- **输入边界**：只给 LLM 原始会话、当前 Agent 状态和 runtime 已有摘要；
- **控制边界**：不要求 Controller 建立复杂的 `complete/blocked/authorize` 状态机，结束和权限由 Harness/runtime 处理；
- **评估方式**：记录消息、耗时、token、工具动作和最终产物，让用户比较模型表现，不输出统一质量分数。

理论仍然有用，但理论不应直接变成运行时抽象。Mixed-Initiative、Grounding、Scaffolding、Joint Cognitive System 和 Supervisory Control 用来解释设计取舍；运行时只需要让 LLM 理解“当前 Agent 做了什么，用户下一条会说什么”。

本项目的 Controller 不是通用人类模拟器，也不是理想化评审员。它是一个**以原始会话为证据、根据当前轨迹动态生成用户输入的轻量模型**。


---

## Canonical v1：理论结论的最终收敛

本节优先于本文前面仍保留的探索性表述，作为工程设计的理论基线。

### 1. Controller 的定义

Controller 不是“最像原用户的句子预测器”，也不是理想专家。它是受原始会话证据约束的监督控制器：根据用户在原始会话中体现的目标、知识、偏好、权限和验收能力，结合候选 Agent 的当前状态，生成与该用户能力边界一致、能够合理推动任务的下一步输入。

等价条件固定的是任务与用户能力边界，而不是后续消息文本。语言风格是弱约束，不能压过任务语义。

### 2. 生命周期原则

`wait` 不是 Controller 的消息意图。Target Agent 仍在运行时，Runner 等待，不调用 Controller。Controller 只在稳定输入边界被调用：

```text
结果满足且证据足够       -> stop(satisfied)
不可恢复或需真实决定     -> stop(blocked / requires_real_user_decision)
方向偏离                 -> send(correct)
缺少已知事实             -> send(inform)
完成声明缺少验收证据     -> send(verify)
只需交还执行权           -> send(continue)
```

`continue` 是协调性输入；`inform`、`correct`、`verify` 是实质性干预。它们不是用户画像或复杂状态机。

### 3. 观察面的理论边界

Controller 应拥有“真实用户可正常观察到的只读状态”，而不是“Target Agent 已主动读取的状态”。用户可观察的 diff、截图、当前文件、既有测试输出和产物预览可以通过 Harness 的声明式适配器提供；隐藏文件、密钥、后台状态和任意 shell 不提供。

观察可以是被动投影或格式转换，但不能是主动探测：协作循环中 Controller 不运行测试、不查询外部系统、不替 Agent 完成诊断。报告阶段的独立验证必须单独标记。

### 4. 证据与历史信息

完整原始会话可以用于理解用户能力、目标和偏好，不建立复杂的逐轮防泄漏系统。但 Controller 不应把原 Agent 后来调查得到的任务答案伪装成用户原本知道的事实。该边界交给固定 system prompt 和 trace 审查，而不是增加第二个审查 Agent。

### 5. 研究证据的使用方式

Claude Code 大样本研究、Web Agent 协作聚类和人机协作综述支持“人负责目标和约束、Agent 负责大量执行”的方向，但不应把其中的百分比直接变成所有任务的规格。Hands-off、Collaborative、Hands-on、Takeover 适合作为运行后的描述标签，不作为运行前 persona。

### 6. 需要诚实停止的情况

当原始会话没有表达用户偏好、且候选 Agent 面临不可逆或高风险选择时，Controller 不猜测，也不制造“让用户确认”的角色循环；Harness 返回 `requires_real_user_decision`。低风险、可逆选择可以发送“采用你认为更稳妥的方案并说明理由”一类委托消息。
