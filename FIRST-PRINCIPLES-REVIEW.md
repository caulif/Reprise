# Reprise 第一性原理审视与优化建议

日期：2026-08-13（2026-08-13 按项目所有者决策修订）
范围：当前工作区全部源码（src ~5.8k 行、test ~1.5k 行）、docs（本地 ~1.4 万行，未入库）、构建与入口脚本。

> **已定决策**
> 1. 统计效度问题采用**方案 B**：产品定位收缩为"重放与检视"（replay & inspect），不做多次重复运行——用户视角下"跑一次看结果"才是真实需求。
> 2. 规范文档**有意**不入库：属于选择性开源策略，后续按需放入，不是疏漏。
>
> 原方案 A 及"docs 全量入库"的论证保留在下文作为决策背景，行动清单已按上述决策修订。

---

## 1. 这个项目本质上在做什么

剥掉所有实现细节，Reprise 回答的是一个问题：

> **"在我真实做过的任务上，换一个模型（同一 Agent Runtime）会不会做得更好？"**

为此它做了四件事：

1. **冻结过去**：把历史 Codex 会话变成不可变的 `TaskCase`（输入、transcript、基线证据、环境指纹）。
2. **重放现在**：在 Harness 拥有的隔离工作区里，用候选模型跑同一个初始输入。
3. **模拟用户**：Controller Agent 代替真实用户做后续协作决策（continue/inform/correct/verify/done）。
4. **诚实比较**：Comparison Agent 基于持久化证据写报告，fidelity 多维标注一切不可复原的条件。

从第一性原理看，这个产品的价值链是：**证据链的可信度 × 重放的保真度 × 比较结论的统计效度**。三者相乘，任何一项为零，整个产品的输出就是零。下面的意见按这条价值链排序。

---

## 2. 总体评价：做对了什么

先说值得保留的判断，避免"优化"破坏已有的克制：

- **端口/适配器边界干净**。`RuntimePort`/`TargetRunner` 在 core，Codex 私有协议完全锁在 `products/codex`，`ScriptedRuntime` 提供无 provider 的可重复开发路径。这是全项目最健康的一条线。
- **"不伪造事实"贯彻得很好**。Agent 失败就是 failed，不降级成假结论；comparison.md 不存在就把 completed 改判 failed；`unknown` 禁止自动重发。这种诚实是同类工具里少见的。
- **七状态状态机 + append-only 事件日志**尺寸合适：21 行的转移表 + 单写者 store，没有过度 Event Sourcing。
- **文档明确列出"当前不做"**（无插件市场、无分布式、无 DSL），且代码基本遵守了。

问题不在方向，而在**几处价值链断点和规范资产的失衡**。

---

## 3. 顶层意见（按优先级）

### P0-1：先回答"一次运行能证明什么" —— 这是产品成立与否的问题

当前真实路径（`startCodexExperiment`）是**单候选、单次运行**：schema 里 `ExperimentSpec.candidates` 是数组，但 `codex-experiment.ts` 写死 `candidates: [input.candidate]`、`runs: [record]`，比较对象是"一次候选运行 vs 冻结的历史基线"。

而 agent 运行的随机性是有硬数据的：

- 对 SWE-Bench-Verified 的 6 万条轨迹分析显示，**单次运行的 pass@1 估计因选取的 run 不同可波动 2.2–6.0 个百分点，temperature 0 下标准差仍超 1.5pp**，轨迹在前几个百分点的 token 处就分叉（[On Randomness in Agentic Evals](https://arxiv.org/abs/2602.07150)）。
- ICC 研究表明 agentic 任务的组内一致性低至 0.30，**结构化任务需要 8–16 次重复、复杂推理需要 ≥32 次才收敛**（[Stochasticity in Agentic Evaluations](https://arxiv.org/html/2512.06710v1)）。

也就是说：**单次运行得出的"候选比历史基线好/差"本质上是一则轶事，不是测量**。项目文档处处强调"条件诚实"，但最大的不诚实恰恰是单次比较本身未被标注为统计无效。

当时的两个候选方案：

- **方案 A**：让真实路径兑现 schema 已有的承诺——支持同一 `TaskCase` 下多候选、每候选 N 次重复，报告以客观可测指标为主轴，LLM 叙事降为附注。
- **方案 B**：诚实收缩产品定位——从"比较 Harness"改为"**重放与检视工具**"（replay & inspect），报告不再输出任何倾向性比较结论。

**✅ 已决策：采用方案 B**。理由：从用户视角出发，"跑一次、看结果"才是真实使用方式；多次重复的统计基础设施与 local-first 单人工具的成本预算不匹配。方案 B 的具体落地项：

1. **措辞对齐**：README 已有"不宣布胜者"，把这一立场上升为产品定位——对外描述从"比较 Agent Runtime"改为"重放历史任务并检视候选表现"。architecture/overview.md 中 Comparison 的职责定义同步收窄。
2. **报告去倾向化**：Comparison 报告呈现"历史基线做了什么 / 候选做了什么 / 客观指标（turns、wall-clock、changed files、termination kind）"的并排事实，不出现 better/worse/preferred 类结论性语言。可以在 Comparison 的 prompt 契约和 Renderer 校验里显式禁止。
3. **顺势简化**：既然不承诺统计比较，schema 中为多候选预留但真实路径永远单候选的部分（`ExperimentSpec.candidates` 数组语义）可以在下次 schema 版本演进时收紧为单候选，减少"看起来支持但实际不支持"的表面积。不紧急，遇到再改。
4. **诚实标注保留**：报告固定注明"单次运行，结果受随机性影响"（一句话即可），这与"条件诚实"的项目价值观一致，成本为零。

### P0-2：规范文档不入库 —— 已确认为有意的选择性开源策略

原审视认为"自称唯一规范却被 gitignore"是矛盾。**✅ 项目所有者确认：这是有意为之**——docs 属于选择性开源资产，后续按需放入，不希望全部文档开源。该前提下，"裁剪后全量入库"的建议撤回。

保留两个与该策略不冲突的残留问题：

1. **对外可见的断链**：README 链接了 `docs/codex-smoke-gate.md`，但克隆者拿不到这个文件。要么把这一份 smoke gate 文档单独入库（它描述的是可复现的验收流程，开源它有利无害），要么把 README 中的链接改为行内摘要。
2. **文档-代码术语漂移仍需管理**：文档不开源不等于不需要和代码对齐。`AgentProductPlugin`、`TaskCaseBuilder`、Case Preparation Service 等类型在代码中不存在（实际是 `codexProductPack`、`freezeCodexSession`）。既然 docs 是私有工作资产，建议在本地修订时以**代码为准**收敛术语，避免未来选择性开源时把漂移一起放出去。

### P1-1：Controller 是产品前提的心脏，但现在喂给它的是占位符

产品的核心假设是"Controller 以同等人类能力模拟后续协作"。但看真实路径的实现：

```256:257:src/application/codex-experiment.ts
      current: { summary: input.currentSummary ?? 'The candidate target turn settled in the isolated workspace.', evidenceRefs: controllerEvidence },
      trajectory: { summary: input.trajectorySummary ?? 'Candidate turns completed in an isolated harness workspace.', evidenceRefs: controllerEvidence },
```

`summary` 默认是**一句常量占位文本**，`evidenceRefs` 只是最近 64 个事件 ID。Controller 虽有只读观察工具可以自己去翻事件，但决策质量高度依赖 harness 主动组装的观察面。一个只知道"turn 结束了"的 Controller，无法做出接近真实用户的 continue/correct/verify 判断——这直接削弱重放保真度这一环。

建议：在 controller loop 每轮 decide 之前，由 harness 确定性地组装最小观察包——**该 turn 的最终 assistant 消息 + 工作区变更摘要（changedPaths 已经有现成实现 `captureWorkspaceScope`）**——替代常量占位。这不需要新抽象，只是把已持久化的事实投影给 Controller。这是全项目投入产出比最高的一处改进。

### P1-2：删除"仪式性保真"——与项目自己的价值观冲突

项目反复强调证据可追溯，但有几处是**形式上的溯源、实质上什么都没验证**：

1. `resolvedAgentConfig`（codex-experiment.ts 407–416 行）把 `promptHash`/`toolPolicyHash`/`contextPolicyHash` 计算为**常量标签字符串的哈希**（如 `hash('reprise-controller-prompt-v1')`）。真实 prompt 内容变了，哈希不变。这比没有哈希更糟：它制造了"已被锁定"的假象。要么哈希真实 prompt/工具清单内容，要么删掉这三个字段只留版本标签。
2. **死配置**：`RunPolicy.heartbeatTimeoutMs` 在 schema 中必填、在两处配置中赋值，但**没有任何执行代码消费它**；`RunPolicy.maxTokens/maxCost`、`AgentBudget.maxCalls/maxTokens/maxCost` 同样未被执行。必填但不生效的策略字段会让使用者误以为受保护。删掉，等真正实现时再加回。
3. `resolveVerifiedCandidate` 用 duck-typing 探测 `validateCandidate`（`runtime as RuntimePort & Partial<CandidateValidator>`），绕过了自己定义的端口。把 `validateCandidate` 正式并入 `RuntimePort`（或删掉这个旁路，统一走 `resolve`）。

### P2-1：收敛入口与配置（三个 composition root、两套配置）

当前存在三条装配路径：fixture CLI（`commands.ts`，用 `config.json`/`HarnessConfig`）、真实 smoke（`scripts/codex-real-smoke.mjs`）、TUI（`harness-model-config` v2）。README 说"避免把受控验证扩展为通用 benchmark CLI"是对的，但**两套持久化配置格式**没有理由并存。建议：统一到 `harness-model-config` 一份，fixture CLI 的 `HarnessConfig` 退役；smoke 脚本保持独立但复用同一配置读取。

### P2-2：代码卫生（小，但有几处是安全边界）

- **重复的安全原语应单点定义**：`SAFE_ID` 正则在 3 个文件各写一份、`writeImmutable` 原子写在 2 处、`hash` 在 3 处、`isRecord` 在 5 处、`errorMessage` 在 4 处。普通 util 重复无所谓，但 **ID 校验、内容哈希、原子不可变写是本项目的安全与完整性边界**，任何一份漂移都会造成难查的事实污染。建议建一个约 40 行的 `src/core/identity.ts`（或 `internal.ts`）收敛 SAFE_ID、hash、writeImmutable；`isRecord`/`errorMessage` 可保留重复。
- **根目录 12 个临时诊断文件**（`.typecheck*.txt`、`.errors*.txt`）删除，并在 `.gitignore` 加一行 `/.typecheck*` `/.errors*`。
- 各 src 子目录残留的 `.gitkeep` 删除。
- `src/tui/codex-intake.ts`（807 行）是最大文件，页面状态机 + 输入分发 + 实验控制混在一个类。**不紧急**——TUI 是外围；只在下次实质修改 TUI 时顺手按 page 拆分，不要专门为拆而拆。

---

## 4. 建议继续"不做"的事（克制清单）

以下诱惑应当抵制，与 docs"当前不做"一节精神一致：

1. **不要在第二个 Product Pack 出现之前抽象插件接口**。`products/index.ts` 静态注册 Codex 是对的；`AgentProductPlugin` 接口留在文档意图里即可，不要预建。
2. **不要扩大 TUI**。TUI 的 `/config → /intake → /run → /history` 闭环已经完整；核心价值在证据链和检视体验，不在终端交互。
3. **不要给 Comparison Agent 加打分/排名能力**。"不统一打分"是这个产品和公共 benchmark 的本质区别，是定位而不是缺陷——方案 B 定案后这一条从"建议"升级为"定位约束"。
4. **不要引入数据库**。JSON 文件 + 单写者事件日志对 local-first 单机场景完全够用。
5. **不要追求跨平台**，在 Windows 路径处理稳定之前（现有代码里 `replaceAll('\\', '/')` 和手工前缀判断已有多处，先收敛这些再谈 macOS/Linux）。

---

## 5. 行动清单摘要

已按两项决策（方案 B；docs 有意不入库）修订：

| 优先级 | 事项 | 状态/预估规模 |
|---|---|---|
| P0 | ~~决策：方案 A 还是方案 B~~ | ✅ 已定：方案 B（重放与检视） |
| P0 | 方案 B 落地：README/架构文档措辞对齐 + 报告去倾向化 + 固定"单次运行"标注 | 半天–1 天 |
| P0 | ~~docs 裁剪入库~~ | ✅ 确认有意不入库，撤回 |
| P1 | 修复 README 对 `docs/codex-smoke-gate.md` 的断链（单独入库或改行内摘要） | 1 小时 |
| P1 | ~~Controller 观察包~~ | ↗ 升级为 P0-5（见第 7 节） |
| P1 | 删除伪溯源哈希与死配置字段；`validateCandidate` 并入端口 | 半天 |
| P2 | 统一为一套 harness 配置 | 半天 |
| P2 | 收敛 SAFE_ID/hash/writeImmutable 到单点；删根目录临时文件与 .gitkeep | 1 小时 |
| P2 | 私有 docs 本地修订时术语向代码对齐（避免未来选择性开源时带出漂移） | 随手做 |
| P3 | schema 演进时把 `candidates` 收紧为单候选语义（方案 B 的顺势简化） | 遇到再改 |

Case Preparation 专项（详见第 6 节）：

| 优先级 | 事项 | 预估规模 |
|---|---|---|
| P0-3 | freeze 时采集确定性环境证据（cwd 现状、git 信息、历史触碰文件/命令清单） | 半天 |
| P0-4 | 环境语义收敛为 replay-from-current / replay-from-commit，删除死掉的 strict 分支与每次 [o] 仪式 | 半天–1 天 |
| P1-3 | ~~报告并排"历史触碰的文件 / 候选改动的文件"~~ | ↗ 并入 P0-7（见第 8 节） |
| P1-4 | Recovery 按需化：无线索跳过、git 场景确定性 checkout、产物回写 case | ~1 天 |
| P2-3 | /run 预填 historicalCwd；inspection 页可选任务起点消息 | 半天 |

Candidate Run 专项（详见第 7 节）：

| 优先级 | 事项 | 预估规模 |
|---|---|---|
| P0-5 | Host 确定性蒸馏每轮观察包（settlement 状态、最终消息、命令、触碰文件、被拒审批），替代常量占位（吸收原 P1-1） | ~1 天 |
| P0-6 | 预算与信号诚实化：budget 传真实决策预算、预算耗尽不记 failed、capabilities 对齐、删占位字段 | 半天 |
| P1-5 | 会话经济二选一：持久 session + 增量 context，删 priorDecisions 重发 | 几小时 |
| P1-6 | 审批拒绝浮出：进观察包 + 报告 limitations 固定呈现 | 半天 |
| P2-4 | preflight/start 复用一次模型目录验证，避免双 spawn | 1 小时 |

Comparison Projection 专项（详见第 8 节）：

| 优先级 | 事项 | 预估规模 |
|---|---|---|
| P0-7 | 报告首屏两列并排：历史 finalMessage+触碰文件 vs 候选最终消息+changedPaths+快照链接（吸收 P1-3） | ~1 天 |
| P0-8 | 真实指标（turns、wall-clock、changed files、token）替代事件序号遥测 | 半天 |
| P1-7 | comparison.md 内嵌 report.html；ComparisonContext 用蒸馏事实替代一行状态码 | 半天 |
| P1-8 | artifacts catalog 传 store.listArtifacts 真实 manifest，删 unknown 占位 | 1 小时 |

## 6. 专项审视：Case Preparation —— 为什么效果远低于预期

（2026-08-13 按项目所有者要求追加。审视范围：`src/products/codex/sessions.ts`、`src/environment/local-workspace-provider.ts`、`src/application/codex-experiment.ts` 中的 preflight/recovery、TUI intake 流程，以及本机 `~/.codex/sessions` 下 20 个真实 rollout 的抽样验证。）

### 6.1 第一性原理：这一环节的唯一使命

Case Preparation 的使命只有一句话：**把一段历史会话变成"可以再跑一次的任务"**。一个可重放任务由三要素构成：

1. **任务输入** —— 候选模型收到什么；
2. **起点环境** —— 候选模型从什么状态开始干活；
3. **基线结果证据** —— 跑完之后拿什么并排检视。

方案 B（重放与检视）定案后，这一环节的地位反而**上升**了：既然产品不再承诺统计比较，它的全部价值就浓缩为"重放起点的质量 × 并排事实的完整度"——而这两样恰恰都由 Case Preparation 决定。当前的落差不是工程质量问题（freeze 链条的原子写、内容寻址 caseId、redaction、幂等复用都做得很干净），而是**三要素只做实了一个**：

| 要素 | 现状 | 完成度 |
|---|---|---|
| 任务输入 | 第一条 user_message + 完整 transcript 冻结 | 基本可用，有真实缺陷（见 6.2 缺口四） |
| 起点环境 | 只有 `historicalCwd` 一个字符串；fingerprint 恒缺失 | **接近零** |
| 基线结果证据 | 只有最后一条 assistant 消息；artifactRefs 恒空 | 约三分之一 |

### 6.2 四个结构性缺口

#### 缺口一：freeze 从不采集环境证据，导致一条永远走不通的死路径

冻结时环境基线是这样写死的：

```182:182:src/products/codex/sessions.ts
    environmentBaseline: { status: inspection.cwd ? 'partial' : 'unavailable', artifactRefs: [] },
```

`fingerprint` 字段永远不写。于是实验准入检查里 `fingerprintDigest(taskCase.environmentBaseline.fingerprint)` 永远返回 `undefined`，`preflightFromBaseline` 的 `sourceBaseline: 'available'` / `fidelity: strict` 分支在真实路径上**一次也不会触发**——每个真实 case 永远是 `partial`，用户每次运行都被迫按 `[o]` 走一遍 observational 确认仪式。schema、fidelity 模型和文档为 strict 比较投入的全部机器，在真实路径上是死代码。这与 P1-2 的"仪式性保真"同源，但规模更大：**不是三个哈希字段，而是整条环境保真链**。

#### 缺口二：时间悖论 —— 就算采集了指纹也复原不了起点

更本质的问题：**冻结发生在会话完成之后**。此刻的 `historicalCwd` 已经包含历史任务的成果——即使 freeze 时补采指纹，候选也是从"已完成状态"起跑，任务的答案已经躺在工作区里。重放的"起点"其实是历史的"终点"。

真正的任务起点只有两条路可以重建：git commit（回退到会话开始时的提交）或事先快照。对本机 20 个真实 rollout 的抽样验证给出了残酷的现实：

- `session_meta` **全部没有 git 字段**（该版本 Codex CLI 未记录，或 cwd 不是 git repo）；
- 真实会话的 cwd 大多是**非 git 的普通文档目录**（课程作业、博客、个人规划），不是代码仓库。

结论：对这类真实 case，"复原历史起点"**物理上不可能**，任何架构投入都改变不了。第一性原理的正确姿势不是建更重的快照机器，而是**诚实收缩语义**——见 6.3 的 P0-4。

#### 缺口三：基线证据不对称，方案 B 的核心交付有一半是空的

候选一侧，`captureWorkspaceScope` 产出 changedPaths + 最多 16 个文本快照，证据充分。历史一侧：

```180:180:src/products/codex/sessions.ts
    baseline: { status: inspection.finalMessage ? 'available' : 'unavailable', ...(inspection.finalMessage ? { finalMessage: inspection.finalMessage } : {}), artifactRefs: [], evidenceRefs: [] },
```

只有最后一条 assistant 消息的文字。而 rollout 里明明有完整的 `function_call`（apply_patch、shell 命令），完全可以**确定性提取**"历史触碰过哪些文件、执行过哪些命令"——这些信息现在被原样塞进 `historicalEvents` 之后就再也无人使用。方案 B 承诺的"历史做了什么 / 候选做了什么"并排事实，历史一侧目前只有一段话。

#### 缺口四：Recovery Agent 无米之炊，且归属错位

真实路径中 Recovery Agent 收到的全部线索是：

```340:343:src/application/codex-experiment.ts
  const clues = [
    { summary: `Provider readiness: ${baseline.readiness.runnable}.`, evidenceRef: 'artifact:environment-baseline' },
    ...baseline.warnings.map((summary) => ({ summary, evidenceRef: 'artifact:environment-baseline' })),
  ];
```

即一句"Provider readiness: isolated." 加上通常为空的 warnings。TaskCase 里已有的 `historicalCwd`、`cli_version`、historical model、transcript 中的环境线索，一个都没传给它。**没有证据可依的恢复只能是表演**：Agent 在一个从用户提供的 sourceRoot 拷贝出来的 staging 里，"恢复"一个它一无所知的环境，然后按契约写一份 recovery.md。每次实验为此支付固定成本：一次 LLM 调用 + 两次全树拷贝（staging + recovered-baselines）；而它失败时实验照常继续——证明它对结果**没有任何影响**，是纯仪式。

还有一处归属错位：架构文档规定 Recovery 属于 Case Preparation（恢复一次、结果冻结进 case、多次重放复用），代码却把它放进每次实验重复执行，恢复产物也不回写 case。

顺带两个任务输入侧的真实缺陷：`initialInput` 机械地取第一条 user_message，而本机真实数据里首条消息可能是寒暄（实测有 "你是什么模型"）；intake 的 eligibility 过滤只看"有 user 消息 + 有完成 turn"，区分不了闲聊会话和任务会话，挑选列表上也看不到"这个会话能不能重放"（cwd 还在吗、是不是 git repo、历史改过几个文件）。

### 6.3 优化建议（克制版）

按投入产出比排序，全部与方案 B 定位一致：

**P0-3：freeze 时采集廉价的确定性环境证据（无 LLM，估计几十行代码）**

1. 检查 `historicalCwd` 现状：是否仍存在；是否 git repo；若是，记录当前 HEAD 与 dirty 状态；rollout `session_meta` 带 git 字段时（新版 Codex）一并记录历史 commit。
2. 从 transcript 的 tool calls 确定性提取"历史触碰的文件清单 + 执行过的命令清单"，写入 `baseline.artifactRefs`（或 taskContext）。

这一步把 TaskCase 从"对话存档"升级为"重放起点"，同时给 intake 列表提供可重放性信号。它是整个 Case Preparation 里唯一既便宜又根本的改进。

**P0-4：环境语义诚实化（方案 B 的配套收缩）**

把永远 `partial` 的仪式换成两档诚实语义：

- `replay-from-current`（常态默认）：从用户提供的 source root 现状起跑，报告固定标注一句"重放起点为该目录当前状态、非历史起点，历史成果可能已在工作区中"——一次性说清楚，**删掉每次 [o] 确认的忏悔仪式**；
- `replay-from-commit`（git 场景兑现时）：cwd 是 git repo 且有 commit 证据时，确定性 checkout 到历史起点，这才是 strict/matched 语义唯一可能兑现的路径。

同时删除或明确搁置真实路径永不触发的 strict 分支，与 P1-2 一并处理。

**P1-3：基线证据对称化**

报告并排呈现"历史触碰的文件 / 候选改动的文件"（数据来自 P0-3 第 2 项）。这是方案 B 下报告价值最直接的提升。

**P1-4：Recovery 按需化**

- 无可行动线索 → 确定性跳过：不调 LLM、不做两次全树拷贝（当前每次实验的固定浪费）；
- 有 git commit 线索 → 确定性 checkout，不需要 Agent；
- Agent 只保留给残余语义缺口（如依赖安装），且把 P0-3 采集的环境线索真正传进 `clues`。同时把恢复产物回写 case（一次恢复、多次重放），修正归属错位。

**P2-3：交互顺手改进**

- `/run` 的 source root 预填 `historicalCwd`，一键确认代替手敲绝对路径；
- inspection 页允许用户确认或更换"任务起点消息"（默认第一条）。这不违反文档"不推断任务边界"的禁令——用户手选不是 Agent 推断。

### 6.4 克制清单补充

1. **不做文件系统快照/时间机器**。非 git 目录的历史起点不可复原，承认它，不要为此建快照守护进程。
2. **不做容器/VM 环境复原**。local-first 单人工具的成本预算撑不起，收益也不成立（用户的真实任务大多是文档目录）。
3. **不为第二个产品预建 `SessionSourceAdapter` 抽象**。与克制清单第 1 条同理，Codex 的 freeze 函数就是当前唯一实现。

---

## 7. 专项审视：Candidate Run —— 协作回路缺了输入端

（2026-08-13 按项目所有者要求追加。审视范围：`src/application/candidate-run.ts`、`src/application/codex-experiment.ts` 中的 controller loop 与 `captureWorkspaceScope`、`src/agents/controller-agent.ts`、`src/infrastructure/pi-agent-host.ts`、`src/infrastructure/agent-tools.ts`、`src/products/codex/runtime-port.ts`，以及生产装配路径 `codex-tui-workflow.ts` 的实际接线。）

### 7.1 第一性原理：这一环节的唯一使命

Candidate Run 的使命也是一句话：**在隔离环境里让候选真的把任务再跑一遍，并让 Controller 以原用户的身份在场陪跑**。它由三要素构成：

1. **忠实驱动** —— 候选收到输入、跑完 turn、结果被如实记录；
2. **有眼睛的陪跑者** —— Controller 看得见候选做了什么，才能替原用户说"继续/纠正/够了"；
3. **每一轮花得值** —— 一次 decide 的成本（LLM 调用 + token）换得一次有信息量的决策。

先说清楚：**要素一做得很好**。`CandidateRun` 状态机（幂等 clientMessageId、单飞 finish、turn 超时竞速、诚实的终止分类）和 `CodexTargetRunner`（原生 turn settlement、拒绝一切 server 发起请求、退出前先 interrupt）是全项目工程质量最高的部分之一。落差全部集中在要素二和三：

| 要素 | 现状 | 完成度 |
|---|---|---|
| 忠实驱动 | 状态机 + 协议客户端 + 事件日志完整 | 高 |
| Controller 观察 | 每轮一句常量占位文本；关键信号一个不传 | **接近零** |
| 决策经济性 | 全量 context × 持久 session 双重支付；预算旋钮标错 | 低 |

这解释了"效果远低于预期"：**协作回路的执行端是精密的，输入端是空的**。一个只知道"turn 结束了"的 Controller，其 continue/correct/done 输出与掷硬币无异——而它的输出恰恰决定实验何时终止、终局如何评估。

### 7.2 四个结构性缺口

#### 缺口一：Controller 全盲，而它需要的事实全部已经在库里

生产路径（TUI workflow）从不传 `currentSummary`/`trajectorySummary`，于是 Controller 每一轮 decide 收到的都是同一句常量：

```256:257:src/application/codex-experiment.ts
      current: { summary: input.currentSummary ?? 'The candidate target turn settled in the isolated workspace.', evidenceRefs: controllerEvidence },
      trajectory: { summary: input.trajectorySummary ?? 'Candidate turns completed in an isolated harness workspace.', evidenceRefs: controllerEvidence },
```

盲的程度逐项数：

- **最关键的一位信号没传**：候选这轮 settlement 是 `waiting_input`（它在提问）还是 `completed`（它认为做完了）。这是 continue vs done 的第一判据，事件里有，context 里没有。
- `evidenceRefs` 是最近 64 个 `event:uuid` token，**不可解引用**——`read_observation` 只能按 cursor 翻页，没有按 id 取事件的通道。它们唯一的用途是让 Controller 在决策里原样引用回来通过校验，零信息量。
- 自救通道不现实：`read_observation(run_events)` 返回的是 **Codex 通知原始 JSON 流**（含大量 `item/updated` 增量噪音），要在 90 秒超时 + 1 次修复的预算内翻页找到"这轮助手最终说了什么"，等于让 Controller 自己做一遍 Host 该做的蒸馏。
- 声明与现实不符：session 声明 capabilities `['read_observation', 'read_artifact', 'read_transcript']`，实际注册的工具只有 `read_observation` 一个——capabilities 是仪式字符串，与 P1-2 的伪溯源同源。

而 Host 手里明明什么都有：该 turn 的最终 assistant 消息、执行的命令、apply_patch 内容、被拒绝的审批请求，全部已作为事件持久化。**与 6.2 缺口三完全同构：事实已入库，但无人投影**。原 P1-1 只指出了占位符问题；真实规模是整个协作回路没有信息输入端。

#### 缺口二：盲人握有终局裁判权，且被告知的预算是错的

- 终局评估 `apparently_completed` 的唯一来源是 Controller 说 `satisfied`——基于占位符做出的"任务看起来完成了"是假信号，报告的 task status 因此不可信。
- 预算旋钮标错：Controller 被告知 `targetTurnsLimit: 4`（maxTargetTurns），但真正卡死它的是 `maxModelCalls: 3`——这个数字从未传给它。预算耗尽走 `stopByHarness('limit.controller_calls')`，termination 记为 **failed**：对方案 B 的用户来说，"聊天预算用完"被记成"实验失败"，且最后一轮 target turn 已 settled 的成果无人检视就被丢弃。
- `permissions.requiresRealUserDecision` 写死 `false`，而 system prompt 却在教 Controller 使用 `done:requires_real_user_decision`——两处契约互相矛盾。
- `controller.started` 事件的 payload 是 `{ model: 'configured' }` 占位字符串，又一处仪式。

#### 缺口三：双重支付的会话经济

`ControllerAgent` 每个 run 保留一个持久 session（模型侧累积完整历史），但每轮 decide 又把**整个 SteeringContext 全量重发**——initialInput 全文、baseline、全部 priorDecisions：

```165:169:src/infrastructure/pi-agent-host.ts
        const content = JSON.stringify(request.context);
        const repair = attempts ? 'Your prior response was invalid. Return only JSON conforming to the required schema.\n\n' : '';
        await this.#audit?.append({ type: 'agent.message_appended', sessionId: this.#sessionId, role: this.#role, payload: { byteLength: Buffer.byteLength(content), repair: attempts > 0 } });
        timer = setTimeout(() => controller.abort(), request.timeoutMs);
        const text = await abortable(this.#session.append({ content: `${repair}${content}`, signal: controller.signal }), controller.signal);
```

第 N 轮的模型输入包含 N 份几乎相同的 context 副本；`priorDecisions` 本来就躺在 session 历史里还要再发一遍。持久 session 和全量重发**只需要一个**，现在两个都付了钱。

#### 缺口四：审批拒绝是不可见的保真断点

`CodexAppServerClient` 拒绝一切 server 发起的请求（安全立场正确，不必改），配合 `approvalPolicy: 'never'`。但历史用户当年可能**批准过**升级操作——重放中候选被拒后只能绕行或放弃，行为从此偏离历史轨迹。这一事实目前只作为 `codex.server_request_rejected` 原始事件躺在日志里：不进 Controller 观察、不进报告 limitations。对一个把"条件诚实"当核心价值观的产品，这是一处应当浮出而没有浮出的保真损失。

顺带三个小缺陷：停滞守卫 `maxConsecutiveNoProgress` 要求两次 send 文本**逐字相等**，LLM 几乎不会逐字重复，守卫形同虚设；一次实验里 `resolveVerifiedCandidate` 在 preflight 和 start 各执行一次，每次都为拉模型目录 spawn 一个完整 app-server 到临时目录（双倍进程成本）；turn 超时后 `waitForTurn` 的 waiter 从不被 reject（promise 泄漏，单进程下无害）。

### 7.3 优化建议（克制版）

**P0-5：Host 确定性蒸馏每轮观察包（无 LLM，~1 天；吸收并升级原 P1-1）**

每轮 decide 之前，从该 turn 的已持久化事件中**确定性提取**：settlement 状态（waiting_input/completed）、最终 assistant 消息、执行过的命令清单、patch 触碰的文件、被拒绝的审批请求。`current` 装本轮摘要，`trajectory` 装之前各轮的一行摘要。纯投影，不需要新抽象，数据全在 `store.events(runId)` 里。

这是 Candidate Run 唯一根本性的改进——Controller 决策质量、终局评估可信度、报告叙事，全部下游于它。它和 P1-3（基线证据对称化）合起来，正好补齐方案 B"历史做了什么 / 候选做了什么"的两侧。

**P0-6：预算与信号诚实化（半天）**

- `budget` 传 Controller 真实的决策预算（maxModelCalls），而不是它管不着的 turn 上限；两个旋钮对用户收敛为一个"最多追问 N 次"；
- 预算耗尽的 termination 不再记 `failed`，用 limit 语义中性呈现（至少报告端措辞中性）；
- capabilities 声明与实际注册工具对齐；`requiresRealUserDecision` 要么接线要么删除；`{ model: 'configured' }` 占位删除。

**P1-5：会话经济二选一（几小时）**

保留持久 session，则首轮发完整 context、后续轮只发增量观察 + 预算变化，`priorDecisions` 字段删除（session 历史已含）。或者反过来放弃持久 session、每轮无状态全量。选一个，别两个都付。

**P1-6：审批拒绝浮出为一等事实（半天）**

`server_request_rejected` 进入 P0-5 的观察包，并在报告 limitations 固定呈现："候选请求了 N 项需要批准的操作，Harness 按策略全部拒绝；历史用户可能会批准。"安全边界不动，只让事实可见。

**P2-4：模型目录验证复用（1 小时）**

preflight 与 start 之间复用一次 `listModels` 结果，避免一次实验 spawn 两个目录查询进程。

### 7.4 克制清单补充

1. **观察蒸馏不用 LLM**。必须是确定性投影（选事件、截断），否则证据链里混入第二个叙事者，Controller 的决策依据本身就成了模型输出。
2. **不给 Controller 写工具或工作区访问**。"模拟用户，不代跑任务"是身份边界，只读观察是对的，缺的是喂给它什么，不是给它更多权力。
3. **不做实时人工干预/流式介入**。方案 B 是"跑一次看结果"，人在环外；timeline TUI 已够用。
4. **不自动批准 server 请求来"提高保真"**。审批缺口用 P1-6 浮出即可，安全边界优先。

---

## 8. 专项审视：Comparison Projection —— 价值链的出口没有货

（2026-08-13 按项目所有者要求追加。审视范围：`src/report/comparison-report.ts`、`src/application/comparison.ts`、`src/agents/comparison-agent.ts`、`codex-experiment.ts` 的 `finishExperiment`、`experiment-store.ts` 的 artifact 布局，以及 TUI 完成实验后对用户的实际呈现。）

### 8.1 第一性原理：这一环节的唯一使命

Comparison Projection 的使命：**把已持久化的事实投影成一张画面，让用户十秒内答出"候选做得怎么样"**。方案 B 定案后，这里是整条价值链的**出口**——Case Preparation 冻结的证据、Candidate Run 记录的事件，最终全部要在这一张报告上兑现。它由三要素构成：

1. **并排事实** —— 历史做了什么 / 候选做了什么；
2. **客观指标** —— 花了几轮、多长时间、改了几个文件；
3. **叙事附注** —— Comparison Agent 帮用户理解差异。

现状：

| 要素 | 现状 | 完成度 |
|---|---|---|
| 并排事实 | 历史侧有 finalMessage；候选侧**连最终消息都没有** | 接近零 |
| 客观指标 | 只有事件序号区间（"Trace events 3–120"） | 仪式 |
| 叙事附注 | 单点依赖 LLM，喂给它的又是一行状态码 | 靠运气 |

用户跑完一次实验，打开 report.html 看到的是：`indeterminate; completed.controller_satisfied (controller)`、fidelity 字符串、事件序号区间、两个标着 `unknown` 的 JSON 文件链接。**报告回答了"这次运行怎么结束的"，没有回答"候选做了什么"**——而后者才是用户按下 `/run` 的原因。真正的答案（候选说了什么、改了哪些文件、文本快照）今天就躺在 `candidate-workspace-scope.json` 和事件日志里，要用户自己点开原始 JSON 翻。

### 8.2 四个结构性缺口

#### 缺口一：投影的中心是空的

`projectRun` 投影的全部内容是状态码字符串：

```45:47:src/report/comparison-report.ts
function projectRun(run: RunRecord): ReportRun {
  const traceCount = run.trace.lastSequence - run.trace.firstSequence + 1;
  return { runId: run.attempt.runId, candidate: run.attempt.candidate.candidateId, model: run.attempt.candidate.requestedModel, taskStatus: run.outcome.task.status, termination: `${run.outcome.termination.kind}: ${run.outcome.termination.code} (${run.outcome.termination.initiatedBy})`, fidelity: `${run.fidelity.comparisonClass}; environment ${run.fidelity.environment}; model ${run.fidelity.modelResolution}`, fidelityReasons: run.fidelity.reasons.map(displayText), telemetry: `Trace telemetry: events ${run.trace.firstSequence}-${run.trace.lastSequence} (${traceCount}).`, warnings: run.warnings.map((warning) => `${warning.code}: ${displayText(warning.message)}`) };
}
```

候选的最终 assistant 消息、changedPaths、文本快照——一个都不投。历史侧尚有 `baseline.finalMessage`，候选侧没有对应物，**连"并排"的形式都不成立**。这是同一个病的第三次发作，与 6.2 缺口三（历史证据入库后无人使用）、7.2 缺口一（run 事件入库后无人投影）完全同构：**管道把事实精密地存了下来，然后在出口处忘了拿出来**。

#### 缺口二：遥测是仪式

"Trace telemetry: events 3–120 (118)" ——事件序号不是指标，对用户是噪音。方案 B 落地项承诺的客观指标（turns、wall-clock、changed files、termination kind）里，除 termination 外**一个都没算**。而它们全部可以从已持久化的事实确定性计算：turns 就是状态机里的 settledTurns，wall-clock 是事件 `occurredAt` 首尾差，changed files 数在 workspace scope artifact 里，token 用量在 Codex 的 token_count 通知事件里。

#### 缺口三：叙事是承重墙，本应是锦上添花

comparison.md 是报告里唯一可能出现"内容"的地方，但它是单点：agent 超时、输出无效或没写文件时，报告的 Comparison 区只剩一句 "No validated comparison narrative is available"——**因为并排事实没做，叙事失败等于报告空心**。而喂给叙事者的蒸馏事实和 Controller 一样接近零：

```24:28:src/application/comparison.ts
    candidates: runs.map((run) => ({
      runId: run.attempt.runId,
      summary: `${run.outcome.task.status}; ${run.outcome.termination.code}.`,
      evidenceRefs: runEvidence(run),
    })),
```

一行状态码。agent 必须在 90 秒预算内自己用 `read_artifact` 翻 256KB 的原始 JSON 才能写出有内容的叙事——comparison.md 的质量因此靠运气。另外 report.html 只放一个指向 comparison.md 的链接，用户要在两份产物之间跳转。

#### 缺口四：元数据在地上，报告里写 unknown

`commitArtifact` 时 kind/mediaType/byteLength 全部写进了落盘 manifest，`store.listArtifacts` 能原样读回；但 `finishExperiment` 调用 `buildComparisonProjection` 时不传 artifacts catalog，投影只好把每个 artifact 标成 `kind: 'unknown'`。机器建好了，生产路径传了个空——与 7.2 的 capabilities 声明、`currentSummary` 参数同款：**参数存在，无人使用**。

顺带说公道话：投影的防御性工程（escapeHtml、safe href 校验、双重 assertComparisonResult、TaskCase/RunRecord 全量 schema 校验、绝对路径去敏）做得很足，href 与 store 落盘布局也核对无误。又是熟悉的签名：**管道精密，内容为空**。路径去敏只打绝对路径、放过相对路径，这一设计是对的，未来投影 changedPaths 时不需要改。

### 8.3 优化建议（克制版）

**P0-7：并排事实进投影（确定性，~1 天；吸收 P1-3）**

报告首屏改为两列并排：

- **历史侧**：finalMessage（已有）+ 历史触碰的文件/命令清单（P0-3 的数据）；
- **候选侧**：最终 assistant 消息（事件日志里有）+ changedPaths / runtimeGeneratedPaths + 文本快照链接（workspace scope artifact 里全有）。

候选侧的数据**今天就齐**，不必等 P0-3/P0-5；它们到位后两列自动对称。这是方案 B 交付物的本体，投影层是全链路最后一公里。

**P0-8：真实指标替代仪式遥测（半天）**

turns、wall-clock、changed files 数、token 用量（有则显示），全部从已持久化事实确定性计算；"Trace events X–Y" 删除或降为附注。与 P0-6 的 termination 中性措辞在同一屏呈现。

**P1-7：叙事降级为附注，并喂饱它（半天）**

- comparison.md 内容内嵌进 report.html（`<pre>` 或轻量渲染），叙事失败时报告依然完整——并排事实是主体，叙事是附注；
- `ComparisonContext.candidates[].summary` 用 P0-7 的蒸馏事实替代一行状态码，让 agent 从"自己翻 256KB JSON"变成"基于已蒸馏事实补充洞察"。

**P1-8：artifacts catalog 传真实 manifest（1 小时）**

`finishExperiment` 用 `store.listArtifacts` 的结果填 `buildComparisonProjection` 的 artifacts 参数，删掉 `unknown` 占位。

### 8.4 克制清单补充

1. **不做交互式报告**。静态 HTML、两列表格、纯链接足够；不引入前端框架或构建步骤。
2. **不让 LLM 参与投影**。叙事只能引用事实，不能成为事实的来源；投影必须保持纯确定性——这是报告可信度的底线。
3. **不做内建 diff 查看器 / 语法高亮**。文本快照链接出去即可，浏览器和编辑器是更好的查看器。
4. **不为多候选、多 run 预建报告布局**。方案 B 是单候选单 run，两列就是全部；`runs` 数组渲染逻辑保留但不扩展。

---

## 参考资料

- [On Randomness in Agentic Evals](https://arxiv.org/abs/2602.07150) — 单次 pass@1 方差 2.2–6.0pp，temperature 0 下仍显著；建议多次独立运行 + 统计功效分析。
- [Stochasticity in Agentic Evaluations: Quantifying Inconsistency with ICC](https://arxiv.org/html/2512.06710v1) — agentic 任务 ICC 低至 0.30；建议 8–32 次重复并报告组内方差。
- [LangChain: Agent Evaluation Readiness Checklist](https://www.langchain.com/blog/agent-evaluation-readiness-checklist) — 多次试验、置信区间、以及"质量指标之外同时跟踪 turns/token/延迟/成本"。
