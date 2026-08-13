# 同等人类协作与 Controller 设计

状态：讨论稿 v0.2（以文末 Canonical v1 为工程基线）

## 1. 目的

Reprise 的被测对象是“模型套在原始 agent runtime 中”的实际使用体验。它不要求把一两个真实任务变成可执行、可复现的私人 benchmark，而是回答一个更窄、也更有用的问题：

> 对同一个人、同一个真实任务和尽量相同的 runtime，换模型后，我是否会得到更好的结果、过程和成本？

这里最难的不是启动 Claude Code/Codex，而是模拟后续人类协作。原始会话下一条消息往往依赖原模型已经走到的状态；无条件 replay 会把原模型的轨迹当成答案泄漏给候选模型。因此 Harness 需要一个基于 Pi Agent Core 的 `Controller / 用户协作代理`，只负责判断用户下一步是否需要介入、介入目的是什么以及何时结束。

本文件记录这一概念的理论依据和实现边界。它是主设计文档第 4 节的深入说明，而不是第二套架构。

## 2. “同等人类能力”到底是什么

### 2.1 不是相同文字，而是相同能力条件

两个模型不可能在不同轨迹上收到完全相同且都自然的后续消息。等价条件应固定：

- 同一原始任务、用户目标和验收意图；
- 同一用户可用的背景知识、偏好、决策权限和信息边界；
- 同一版本的 agent runtime、工具、MCP、权限、沙箱、provider 解析和上下文策略；
- 同一个 Controller 模型、system prompt、可见观察材料和默认预算。

不固定：后续消息的表面文本、发送时机、干预次数、Agent 的执行路径以及最终产物。更强模型少获得几次帮助，是产品效用的一部分，不是“不公平”。

可操作定义是：

> 每个候选都面对同一个任务和用户能力边界；Controller 根据该候选的当前状态，生成一个真实用户在此状态下合理会给出的下一步动作。

因此“等价”是条件等价（same task and user capability），不是轨迹等价（same transcript）。输入的语义条件相同，消息文本可以不同。

### 2.2 Controller 代表什么、不代表什么

Controller 不是另一个被测执行 Agent，也不是通用的人类模拟器。它代表这个具体用户在该任务中的协作能力：知道什么、在乎什么、能否做决定、会检查什么，以及何时认为继续没有价值。

它可以：

- 从原始会话提取目标、偏好、已知事实和隐含验收标准；
- 读取 Harness 提供的当前轨迹和只读证据；
- 发送补充信息、纠正方向或要求验证；
- 选择等待、结束，或在安全预算内继续。

它不应：

- 替 Target Agent 修改文件、点击网页或执行任务；
- 访问真实用户没有权限、也不会看到的隐藏状态；
- 为了“公平”强行复刻原始用户逐字消息；
- 输出统一质量分数替用户作最终价值判断。

## 3. 理论依据

### 3.1 Mixed-initiative interaction

Horvitz 的 mixed-initiative interaction 认为人和系统可以动态决定谁在何时取得主动权。对应到 Harness，第一决策不是“下一条固定提示是什么”，而是“当前是否值得用户介入”。这支持 `wait` 作为一等结果，也解释了为什么不同模型的干预次数可以不同。

### 3.2 Grounding 与共同认知

Clark 与 Brennan 的 grounding 理论把协作看作持续建立共同理解。历史消息只说明过去的共同认知；候选模型走到另一状态后，Controller 必须重新判断误解、缺失事实和验收标准，而不是把旧消息当作永远有效的脚本。

### 3.3 Scaffolding

Wood、Bruner 与 Ross 对 scaffolding 的描述是：根据执行者当前困难提供恰好足够的帮助，并在其能自主完成时撤除帮助。Controller 的正确目标是恢复“帮助的能力边界”，不是最大化干预量。过度补充会让弱模型看起来被用户托举得很好，过度纠正又会掩盖模型自己的规划能力。

### 3.4 Joint cognitive system 与 distributed cognition

被测结果属于“用户 + Controller + Agent runtime + 模型 + 工具 + 工作环境”的联合认知系统。文件、diff、测试输出、浏览器页面和截图都是共享认知的一部分。只看 Agent 的自述会把“会汇报”误当成“做得好”，也无法支持验证型协作。

### 3.5 监督控制与管理例外

在 supervisory control、levels of automation 和 management-by-exception 中，监督者通常观察系统状态，正常时放手，偏离时介入，并保留接管或停止权。这正是本项目的循环：

```text
观察当前状态 -> 等待 / 补充 / 纠正 / 验证 / 结束
            -> Agent 继续执行 -> 获得新的状态
```

Controller 不是预先写好的规则引擎，而是一个有固定能力边界的高层监督者。

## 4. 现实世界的人—Agent 协作启示

公开研究和产品观察呈现出几个稳定模式：

1. **人负责目标、约束和何时算完成，Agent 负责大量局部执行。** Anthropic 对约 40 万次 Claude Code 会话的分析报告称，人类承担约 70% 的规划相关决策，Agent 承担约 80% 的执行相关决策；专家用户提供的每次输入通常能让 Agent 自主完成更多工作，并更能从错误或误解中恢复。这直接支持“同等能力边界、动态消息”的设计。
2. **协作是交替推进，不是一次委托。** 真实用户会在 Agent 需要领域事实、暴露错误假设、提出高风险改动或声称完成时介入；正常进展时会等待。
3. **验证是协作动作，不只是最后评分。** 用户通过 diff、运行结果、测试、截图、产物预览和外部状态判断“完成”是否可信；但用户通常要求 Agent 自己完成验证，而不是自己替它执行所有检查。
4. **专业知识会改变交互，不只是改变答案。** AI pair programming 和用户模拟研究都表明，用户的领域知识、偏好表达和反馈质量会显著影响任务成功，不能用统一“人类策略”替代具体用户。
5. **信任需要校准。** 自动化偏差和过度信任要求系统呈现可核查证据、失败和不确定性；本项目的报告应展示证据而不制造一个看似精确的总分。

这些事实不要求本项目建立复杂 persona 系统。最小做法是把原始会话、用户偏好和权限作为 Controller 的上下文，并允许它根据当前候选轨迹动态行动。

## 5. Controller 的只读观察工具

### 5.1 结论：应该有，但必须是 Harness 的声明式观察面

Controller 若只看到 Target Agent 的文本，就无法判断产物是否真实改变，也无法合理提出“请验证”。因此应提供只读观察能力，但不提供任意 shell 或任意浏览器控制权。Controller 通过结构化 `ObservationBundle` 观察：

- 当前 Agent 消息、工具事件和工具结果；
- 已发生的文件变化与 diff 摘要；
- Target Agent 已运行的测试、构建或命令结果；
- 截图、页面预览和生成物摘要；
- 错误、阻塞、等待输入、无进展信号；
- 已用时间、turn、调用量和成本遥测。

### 5.2 边界

- Controller 不写入任务环境，不替 Target Agent 执行操作；
- 观察内容不超过真实用户在该实验条件下可获得的范围；
- Harness 采集证据并写入 trace，Controller 只引用证据，不修改证据；
- 协作循环中不偷偷运行新的测试来替 Agent 完成任务；可以要求 Target Agent 验证；
- 报告阶段可以运行用户明确授权的独立检查，但必须单独标记为 harness verification；
- 不提供隐藏的全量文件系统、密钥、网络后台状态等“上帝视角”。

这样既避免把 Controller 变成第二个执行 Agent，也避免因只相信 Agent 自述而失去可观察性。

## 6. 三类行为的语义区分

不需要复杂规则引擎。让 Controller 自由生成消息，同时要求它输出一个轻量 intent 标签，用于 trace 和报告解释。

```ts
type ControllerDecision =
  | { type: "wait"; reason: string }
  | {
      type: "send";
      intent: "inform" | "correct" | "verify";
      message: string;
      reason: string;
      evidenceRefs?: string[];
    }
  | { type: "done"; reason: string };
```

判别标准是“当前状态下这条消息主要改变什么”：

| intent | 触发条件 | 典型消息 | 不应混淆为 |
| --- | --- | --- | --- |
| `inform` 补充信息 | Agent 缺少用户掌握的事实、偏好、约束或决策 | “目标用户主要用手机端，桌面布局不是优先项。” | Agent 已偏离目标 |
| `correct` 纠正方向 | Agent 的理解、计划或产物已与目标发生可识别偏差 | “我不是要重写页面，只需修复筛选状态丢失。” | 单纯提供新事实 |
| `verify` 要求验证 | Agent 声称完成、改动有风险或已有产物但证据不足 | “请运行相关测试并展示最终页面效果。” | 直接告诉 Agent 正确答案 |

保留两个控制结果：`wait` 表示无需新增人类信息，`done` 表示已足够完成、无法继续或继续不会增加有效信息。未来若真实任务频繁出现付款、发送、发布等明确授权动作，再增加 `authorize`；第一版不预设第四类。

intent 不是评分，也不强制消息句式。它只用于：解释两次运行得到的帮助为何不同、检查 Controller 是否过度干预、统计过程效率，以及让用户追溯每次介入的依据。

## 7. 最小运行循环

```text
原始会话 + 固定用户能力上下文
        -> Target Agent 在匹配 runtime 中执行
        -> Harness 生成 ObservationBundle
        -> Controller: wait / inform / correct / verify / done
        -> 继续执行或结束
        -> 报告展示过程遥测与 Agent 选择的结果证据
```

Controller 的 system prompt 应明确：它代表原始用户的协作能力；可以相信自己的任务理解；不执行任务；优先等待；只在有信息价值、方向偏差或验证需要时介入；不为了统一消息而泄漏另一条候选轨迹。

## 8. 公平性、解释和限制

同等人类协作不是因果识别意义上的完美公平实验。Controller 自身也可能有随机性、偏见或能力差异，真实用户状态也可能不完整。报告应记录：Controller 模型/版本/config、每次决策及 intent、观察证据引用、停止原因、runtime/environment 匹配状态。

结果应优先呈现：墙钟时间、模型调用数、token/成本、工具调用、失败/重试、干预次数和时机，以及 Agent 自主选择的产物证据。主观质量不压缩成总分，让用户并排查看 diff、截图、测试输出和最终文件。

## 9. 待讨论问题

- 原始会话中哪些信息是用户当时已知、哪些是事后才知道，需要怎样标注？
- Controller 是否应看到未被 Target Agent 读取的文件摘要？默认应遵循“用户可见但 Agent 未必主动读取”的边界，避免隐藏帮助。
- 报告阶段的独立验证是否会改变用户对“Agent 自己完成”的理解？建议与协作循环证据明确分栏。
- 对浏览器、桌面应用和外部副作用，何种 snapshot 足以让结果从 `observational` 升级为 `controlled`？

## 10. 参考资料

- Horvitz, *Principles of Mixed-Initiative User Interfaces* (1999), https://doi.org/10.1145/302979.303030
- Clark & Brennan, *Grounding in Communication* (1991), https://doi.org/10.1037/10096-006
- Wood, Bruner & Ross, *The Role of Tutoring in Problem Solving* (1976), https://doi.org/10.1111/j.1469-7610.1976.tb00381.x
- Hollnagel & Woods, *Joint Cognitive Systems* (2005), https://doi.org/10.1201/9781420038194-10
- Hutchins, *Cognition in the Wild* (1995), https://doi.org/10.7551/mitpress/1881.001.0001
- Parasuraman, Sheridan & Wickens, *A Model for Types and Levels of Human Interaction with Automation* (2000), https://doi.org/10.1109/3468.844354
- Sierra Research, *τ-bench: A Benchmark for Tool-Agent-User Interaction* (2024), https://arxiv.org/abs/2406.12045
- Anthropic, *Agentic coding and persistent returns to expertise* (2026), https://www.anthropic.com/research/claude-code-expertise
- Microsoft Research, *The Effects of Generative AI on High-Skilled Work* (2025), https://www.microsoft.com/en-us/research/publication/the-effects-of-generative-ai-on-high-skilled-work-evidence-from-three-field-experiments-with-software-developers/
- earendil-works, *Pi Agent*, https://github.com/earendil-works/pi

## 11. 从前续讨论收敛出的产品决策

本项目经过多轮讨论后，以下决策已经稳定下来：

### 11.1 被测对象是模型，但测量单位是实际 Agent 产品

模型是因变量；Claude Code、Codex 等 runtime 是承载模型的实验条件。固定 runtime 并不等于“只评测基础模型”，因为用户真正购买和使用的是模型嵌入后的 Agent 产品。若 runtime 版本、动态 system prompt、工具、MCP、权限、沙箱、provider 别名、压缩和重试设置不同，报告必须明确为 `version_mismatch` 或 `compatibility_experiment`。

闭源 runtime 可能存在无法验证的内部提示词和路由。Harness 不应假装恢复未知细节，而应记录：已确认字段、推断字段、未知字段和证据来源。

### 11.2 不在 Pi 内执行目标任务

Pi Agent Core 只承载 Controller 的模型调用、上下文、生命周期和遥测复用。Claude Code/Codex 由各自的 Target Runner 启动。原始会话直接作为 Controller 的任务材料和基线，不转换成另一套标准答案。

### 11.3 任何任务都可以进入，但结论强度取决于环境

任务不限制为 Git 或 CLI。代码、浏览器、桌面应用、文档、表格、研究和外部业务系统都可以尝试。不能恢复的环境不是“禁止测试”，而是把结论降级为 `observational`，并在报告中展示外部状态变化和不可控因素。

### 11.4 结束条件以 Agent 原生生命周期为主

默认值应使用户无感，但允许调整。Target Runner 优先使用 Claude/Codex 自己的 turn 完成或失败事件；Controller 决定继续或完成；Harness 只用超时、turn、调用量和无进展预算兜底。预算停止不能伪装成任务完成。

### 11.5 不建立统一质量分

过程指标直接统计：墙钟时间、模型调用、token、费用、工具调用、重试、失败和 Controller 干预。任务结果由 Evidence Agent 选择最有信息量的 diff、截图、测试、文档或生成物，由用户自行判断，不把跨任务主观价值压成一个分数。

### 11.6 复用成熟能力

Pi 已有的事件订阅、工具前后钩子、停止判断和遥测优先复用。Harness 只补充 runtime 恢复、观察包、trace 归一化和跨运行报告，不重复实现完整 Agent 框架。

## 12. 人类能力的四个维度

“同等人类能力”如果只写成一个 prompt 会过于含糊。更准确的最小模型是四个维度：

| 维度 | 含义 | 来源 | Controller 如何体现 |
| --- | --- | --- | --- |
| 目标能力 | 知道任务为何重要、什么结果算有用 | 原始开场和历史决策 | 维持目标，不把局部完成当整体完成 |
| 领域能力 | 用户掌握的事实、术语、偏好和约束 | 原始会话中已经出现的内容 | `inform` 补充缺失事实 |
| 监督能力 | 能发现方向偏差、风险和过早宣称完成 | 用户历史纠正与验证行为 | `correct`、`verify` |
| 授权能力 | 知道哪些操作可以自动做，哪些需要用户确认 | 权限、风险和历史确认 | 暂时归入消息或 `done`；高风险任务再引入 `authorize` |

这四个维度不是评分维度，也不要求从历史会话中精确量化。它们只是帮助 system prompt 不遗漏“用户能力边界”的不同来源。

## 13. 观察面：可见性矩阵

Controller 的观察权限可用三层区分，而不是简单的“有工具/没工具”：

| 层 | 内容 | 默认 | 原因 |
| --- | --- | --- | --- |
| 轨迹事实 | Agent 消息、工具调用、工具结果、原生事件 | 必须提供 | 这是协作当前状态 |
| 用户可见产物 | diff、截图、已生成文件、测试输出、页面预览 | 提供摘要和按需细节 | 用户通常据此监督 |
| 隐藏环境状态 | 未展示文件、密钥、后台数据库、未发生的测试 | 禁止 | 会赋予 Controller 非真实能力 |

“用户可见”不等于“Agent 已读取”。例如用户可以看见一个页面截图，但 Agent 尚未解释它；Controller 可以据此要求 Agent 验证，却不能直接修复页面。Harness 采集的摘要应带时间戳和来源，避免 Controller 把后来产生的证据带回之前的决策。

### 13.1 为什么不开放任意只读 shell

任意只读 shell 看似方便，实际上会产生三个问题：

1. Controller 可能替 Target Agent 完成搜索、测试和诊断，测量对象从“模型”变成“两个 Agent 的合体”；
2. 不同平台的命令、权限和输出不可比，观察面难以复现；
3. 用户无法判断某个结果来自 Agent 还是 Controller 的隐藏操作。

因此首版应提供固定 observation adapters；确有需要的新观察能力应作为声明式适配器加入并记录版本。

## 14. 三类行为的判别流程

标签不应由字符串规则猜测，可以让 Controller 先回答三个内部问题，再输出一条自然消息：

1. **缺的是事实还是方向？** 缺少用户掌握但尚未表达的事实，倾向 `inform`；
2. **当前方向已经错了吗？** 若目标、计划或产物与任务意图出现可识别偏差，倾向 `correct`；
3. **主要问题是没有证据吗？** 若 Agent 声称完成但缺少可核查结果，倾向 `verify`。

如果三个问题都是否，返回 `wait`。如果任务已达到用户可接受状态、无法继续或继续不会产生信息，返回 `done`。

这三个 intent 允许重叠：例如“请不要改 API，并先运行回归测试”同时包含纠正和验证。首版规定选择主要目的，并可在 `reason` 中说明次要目的；不要为此引入多标签规则系统。

## 15. 真实协作中的信任与验证

人类使用 Agent 往往处于“部分信任”状态：愿意授权局部执行，但会对高影响操作、不可逆操作和完成声明进行检查。自动化偏差研究提示，系统应帮助用户校准信任，而不是用一个绿色的“成功”标记替用户判断。

对 Harness 的直接要求是：

- 把 Agent 的自述和外部证据分开显示；
- 把“测试由 Agent 执行”和“测试由 Harness 在报告阶段执行”分开显示；
- 显示失败、重试、阻塞和未验证的声明；
- 对跨运行不可比的外部状态给出醒目标记；
- 让用户可以从报告回到原始 trace，而不是只看总结。

## 16. 运行有效性分级

为了避免把不同强度的结果混为一谈，报告可以采用四级状态：

| 状态 | 含义 |
| --- | --- |
| `strict_match` | runtime 和环境关键字段均匹配，起始状态可验证 |
| `version_mismatch` | 任务可运行，但原 runtime 版本或关键配置无法匹配 |
| `environment_mismatch` | runtime 基本匹配，但文件、浏览器、外部服务或权限状态不同 |
| `observational` | 只能观察一次真实运行，无法合理声称对照 |

状态不是任务成败，也不是模型质量分。它只表示“这次比较可以被相信到什么程度”。用户可以继续探索性运行，但界面必须同时显示状态。

## 17. 已知风险与简化策略

- **Controller 能力过强：** 固定 Controller 版本和上下文，记录每次观察和消息；不尝试建立复杂防泄漏协议。
- **Controller 能力过弱：** 允许用户在原始会话基础上补充“这个任务中我通常会关注什么”，但保持同一 Controller 配置比较候选。
- **原始会话信息不完整：** 标注未知，不从结果反推用户当时一定知道某事实。
- **任务有外部副作用：** 默认使用副本、测试账号或用户授权的隔离环境；无法隔离时降级状态。
- **单次运行偶然性：** 项目目标本来就是一两个真实任务的个人探索，不把单次结果宣传成普遍 benchmark；必要时允许用户重复运行查看稳定性。
- **主观结果难以比较：** 不强行分数化，展示候选各自产物与证据，让用户结合真实需求判断。

## 18. 当前推荐的最小接口

```ts
type ObservationBundle = {
  turn: number;
  agentEvents: AgentEvent[];
  changedArtifacts: ArtifactSummary[];
  executedChecks: CheckResult[];
  previews: PreviewRef[];
  blockers: Blocker[];
  telemetry: TelemetrySnapshot;
};

type ControllerDecision =
  | { type: "wait"; reason: string }
  | {
      type: "send";
      intent: "inform" | "correct" | "verify";
      message: string;
      reason: string;
      evidenceRefs?: string[];
    }
  | { type: "done"; reason: string };
```

这些类型表达边界，不意味着现在就要建立大型类型系统。实现时优先采用 Pi 已有事件类型和最小适配层；只有跨 runtime 的字段无法统一时才增加归一化结构。

## 19. 继续探索的方向

- 研究 Claude Code、Codex、Cursor 等产品中“等待、审批、恢复、验证”的真实交互差异；
- 用少量真实历史会话检查四种能力维度是否足够表达用户协作；
- 观察 Controller 是否频繁把“缺事实”误判成“方向错误”；
- 评估固定 observation adapters 是否覆盖浏览器、文档和桌面应用；
- 设计报告中的时间线视图：Agent 事件、Controller intent、证据和停止原因对齐显示；
- 研究是否需要 `authorize`，以及它是否应成为独立的用户能力，而不是 `inform` 的特例。

## 20. 新增参考资料

- *How Developers Interact with AI: A Taxonomy of Human-AI Collaboration in Software Engineering* (2025), https://doi.org/10.1109/forge66646.2025.00033
- *Human-AI Collaboration in Software Development: A Mixed-Methods Study of Developers’ Use of GitHub Copilot and ChatGPT* (2025), https://doi.org/10.1145/3696630.3730566
- Microsoft Research, *The Effects of Generative AI on High-Skilled Work: Evidence from Three Field Experiments with Software Developers* (2025), https://www.microsoft.com/en-us/research/publication/the-effects-of-generative-ai-on-high-skilled-work-evidence-from-three-field-experiments-with-software-developers/
- Anthropic, *Agentic coding and persistent returns to expertise* (2026), https://www.anthropic.com/research/claude-code-expertise
- Sierra Research, *τ-bench: A Benchmark for Tool-Agent-User Interaction* (2024), https://arxiv.org/abs/2406.12045
- Sierra Research, *τ²-bench* (2025), https://github.com/sierra-research/tau2-bench
- ServiceNow, *BrowserGym / WorkArena*, https://github.com/ServiceNow/BrowserGym




---

## Canonical v1：工程实现基线

本节是本文件中工程实现的唯一规范；前文的理论讨论和候选方案用于解释取舍。理论依据见[Controller 设计深度分析](../../../research/controller-foundations.md)。

### 1. Runner 与 Controller 的职责

```text
Target Runner：启动并恢复原始 Agent runtime，监听原生事件和输入边界
Harness：隔离环境、采集 trace、生成只读 ObservationBundle、执行预算
Controller：在稳定输入边界生成用户消息或诚实停止
Target Agent：执行任务并产生工具调用、文件和外部产物
```

Target Agent 只收到普通用户文本，不需要知道 `intent`、`reason` 或 Harness 协议。结构化决策只存在于 Harness trace 和报告中。

### 2. Canonical 决策接口

```ts
type ControllerDecision =
  | {
      action: "send";
      message: string;
      intent: "continue" | "inform" | "correct" | "verify";
      reason: string;
      evidenceRefs?: string[];
    }
  | {
      action: "stop";
      reason:
        | "satisfied"
        | "blocked"
        | "requires_real_user_decision"
        | "no_further_value";
    };
```

`wait` 是 Runner 状态，不是 Controller 输出。`clarify` 暂不作为发送 intent：低风险可逆选择可委托 Agent，高风险或不可逆选择返回 `requires_real_user_decision`。

### 3. 调用时机

Runner 只在下列事件调用 Controller：

- Agent 到达稳定的用户输入边界；
- Agent 需要继续但没有发生原生失败；
- 失败后仍存在合理的用户恢复输入。

Agent 仍在运行时不轮询 Controller。原生完成事件不自动等于任务完成：Controller 仍可要求 `verify`，也可以直接 `stop(satisfied)`。

### 4. ObservationBundle 的权限

Controller 观察的是“用户可观察面”，不是“Agent 已读面”。首版适配器可以提供：

- Agent 消息、工具事件和工具结果；
- 当前文件和 diff 摘要；
- 已经执行的测试、构建和命令结果；
- 当前截图、页面预览和生成物摘要；
- 错误、阻塞、无进展和 telemetry。

这些观察必须是被动投影或格式转换。Controller 不运行 shell、测试、构建、网络请求或业务操作；报告阶段若有 Harness 独立验证，必须单独标注为 `harness_verification`。

### 5. Controller system prompt 的核心约束

- 代表原始会话中的这个具体用户，不是理想专家；
- 使用原始会话理解目标、知识、偏好和权限；
- 不机械 replay 后续消息；
- 不把原 Agent 后来发现的答案伪装成用户原有知识；
- 优先不干预；只在方向偏差、缺少已知事实或验收证据不足时发送消息；
- 无法替用户作高风险决定时诚实停止；
- 对 Target Agent 只输出自然语言，结构化字段由 Harness 记录。

### 6. 报告要求

报告至少展示一条时间线：Target Agent 原生事件、Controller 的 send/stop、intent、证据引用、耗时、token、成本、工具动作、失败和终止原因。主观质量不压缩为总分；用户查看候选产物和证据自行判断。

### 7. 第一版不实现的内容

- 用户协作风格分类器；
- 复杂 User Model、Evidence Graph 或防泄漏审查 Agent；
- Controller 任意只读 shell；
- Controller 的统一质量评分；
- 把 `authorize` 预设为通用第四类行为。

`authorize` 只有在真实会话显示权限审批是不可忽略的独立交互边界时才增加。
