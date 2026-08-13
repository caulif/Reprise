> 已由 [Claude Code 风格 Benchmark TUI 工作台重构规划](./claude-code-style-benchmark-tui-plan.md) 取代。本文保留为历史依据，不应继续按其 setup-first 向导实现。

# Reprise 成熟交互式 TUI 实施规划

状态：待实施
日期：2026-08-11
首个纵切片：Codex

> 本文中的 GUI 指类似成熟 Coding Agent 产品的全屏交互式终端界面（TUI），不是桌面或 Web GUI。

## 1. 目标与完成定义

Reprise 是本地优先的历史任务重放和候选模型比较 Harness，不是“输入新任务”的通用 Coding Agent，也不是只读日志监视器。

唯一主流程：

```text
首次使用时通过 Pi 配置 Harness 内部 Agent 模型
→ 选择 Claude Code、Codex 等目标 Agent 产品
→ 选择或发现该产品中的一段高价值历史会话
→ 将这段完整会话冻结为 TaskCase
→ Recovery Agent 与 Environment Provider 恢复会话开始前环境，Harness 解析并记录当前已安装 Runtime
→ 从目标 Runtime 已配置或可验证的模型中选择候选
→ 检查运行条件并创建隔离副本
→ 候选模型在原 Agent 产品中执行任务
→ Controller 根据当前轨迹动态生成后续用户输入
→ Comparison Agent 整理原始结果、候选产物和过程遥测
→ 用户在 TUI 摘要和本地并排报告中自行判断
```

### Goal

用户无需内部脚本，仅用键盘从一段真实历史会话开始，完成冻结、恢复、候选执行、动态控制、比较和报告查看。

### Non-goals

- 不开发桌面 GUI；
- 不获取或模拟隐藏 chain-of-thought；
- 不建立第二套凭据存储、Runtime、runner 或实验状态机；
- 不修改原仓库或目标 Agent 的全局配置；
- 不自动批准权限请求；
- 不并行开发多个未经验证的 Product Pack。

### Acceptance Criteria

以第 8 节清单为准。核心证据是一段真实 Codex 历史会话完成整条流程，并留下不可变 TaskCase、恢复证据、连续可重放 trace、终态 RunRecord、TUI 摘要和并排报告。

### Verification

Node fixture/集成测试、可注入 TUI 键盘流测试，以及一次显式启动的真实 Codex 历史会话验收。规划文档、历史 runner、用户会话、冻结源码和实验产物不提交。

### Risk Boundaries

Candidate 只在隔离副本运行；Recovery Agent 只提出步骤，Environment Provider 验证结果；真实模型调用由用户明确启动；任何失败不得覆盖旧数据或污染原环境。

## 2. 第一性原理与边界

### 2.1 两类模型不能混淆

Harness 内部 Agent：Recovery、Controller、Comparison，通过 Pi 配置和调用。首次设置一个默认模型，以后才允许按角色覆盖。

候选模型属于目标 Agent Runtime：

- Codex 候选由 Codex Runtime 发现或验证；
- Claude Code 候选由 Claude Code Runtime 发现或验证；
- 不能用 Pi model catalog 冒充候选列表；
- RunManifest 同时记录 requested model 和 Runtime resolved model。

首个 Codex 验收固定使用：

- Candidate：`gpt-5.6-luna / high`；
- Recovery、Controller、Comparison：`gpt-5.6-terra / medium`。

### 2.2 单一事实来源

- 目标产品会话提供原始历史事实；
- TaskCase 是不可变实验输入；
- Environment Provider 负责恢复、隔离和 fingerprint；
- CandidateRun 负责运行终态和 cleanup；
- ExperimentStore 负责持久化事件；
- Controller 的决定和实际发送文本分别落盘；
- Comparison 组织证据，不替用户宣布赢家；
- TUI 只投影事实和发送用户意图。

### 2.3 Ponytail 实施规则

1. 复用 Pi 的 provider/model/credential 能力，不保存第二份 API key；
2. 复用现有 Product Pack registry、Codex fixture freeze、RuntimePort、CandidateRun、RecoveryAgent、Environment Provider、Store observer 和 timeline projection；
3. 复用已安装的 `@earendil-works/pi-tui`，不增加依赖；
4. 只补真实流程缺少的会话发现、模型验证、可取消运行和多轮 Controller；
5. 不建立 screen framework、event bus、Redux store、插件容器或页面 class 层级；
6. 先完成 Codex，再用第二个真实 Product Pack 检验公共契约；不先写 Claude Code 空壳。

## 3. TUI 用户流程

整个流程使用一个 `TuiAltScreen` 应用。以下是页面职责，不要求一个页面对应一个 class 或文件；能合并就合并。

### 3.1 首次设置：Pi 内部 Agent

没有有效配置时显示：

```text
Reprise · Harness setup
Provider   <Pi provider>
Model      gpt-5.6-terra
Effort     medium
Roles      Recovery · Controller · Comparison

[Enter] Validate and save   [q] Quit
```

要求：

- provider/model 枚举和凭据处理复用 Pi；
- Reprise 只保存非敏感模型选择；
- 保存前执行最小连接/模型验证；
- 失败留在当前页并显示原因；
- 再次启动跳过向导；
- 一个默认模型即可，不创建三套重复配置流程。

### 3.2 选择目标 Agent 产品

```text
Select target Agent product
❯ Codex         installed · <version>
  Claude Code   not supported yet
```

列表来自 Product Pack registry。Pack 只读探测 executable、version、会话发现能力和候选验证能力，不修改目标产品配置。Codex 完整验收前，Claude Code 只显示真实支持状态。

### 3.3 发现并选择高价值历史会话

Product Pack 只读扫描目标产品会话，显示时间、仓库、任务摘要和可解释信号：

- 有明确用户任务；
- 有多个有效步骤或工具调用；
- 有文件变化或产物；
- 有测试或验证命令；
- 会话完整且能关联开始前环境；
- 任务量适中。

这些信号只负责排序和过滤，不由模型武断决定“价值”。用户查看完整摘要、原始路径、隐私提示、环境证据和缺口后做最终选择。扫描过程不得执行历史会话中的命令。

### 3.4 冻结完整会话为 TaskCase

确认后冻结：

- 完整 user/assistant/tool transcript；
- 原始事件和顺序；
- 初始用户输入和原始最终结果；
- 原 Runtime 版本与模型证据；
- 文件、patch、测试等 baseline 产物引用；
- 会话开始前环境线索；
- provenance、content hash 和隐私策略。

写入必须不可变：相同内容复用同一 case，冲突不能覆盖。隐私处理发生在写入前；失败不能留下可被误认为完整 TaskCase 的记录。

### 3.5 Recovery、Environment 与当前 Runtime

TaskCase 冻结后自动准备：

```text
Recovery Agent          planning
Environment Provider    staging
Source baseline         verified
Dependencies            restored / partial
Runtime                  Codex <version>
Environment fidelity    full / partial / unavailable
```

顺序和职责：

1. Harness 从 TaskCase 生成 RecoveryContext；
2. Recovery Agent 仅提出 staging 范围内的恢复步骤；
3. Environment Provider 执行允许的确定性步骤；
4. Provider 用 fingerprint 和检查命令验证结果；
5. Harness 解析并记录当前已安装 Runtime 的 executable、version 和 capabilities；
6. 恢复事实、缺口和 fidelity 落盘。

恢复目标是历史会话开始前环境，不是原会话完成后的工作区。Recovery Agent 不能自行宣称恢复成功，也不能任意写原仓库。

- `full`：正常继续；
- `partial`：展示缺口，由用户决定是否做 observational comparison；
- `unavailable`：禁止启动 Candidate。

### 3.6 从目标 Runtime 选择候选

Product Pack 从当前 Runtime 获取已配置模型、可枚举别名，或验证用户输入的模型标识：

```text
Runtime      Codex <version>
Candidate  ❯ gpt-5.6-luna   configured · valid
Effort       high
```

要求：

- 验证只作用于 run-local 配置；
- 不修改全局 Agent 配置；
- 无法枚举时允许输入，但启动前必须验证；
- requested/resolved model 都落盘；
- 首版一次运行一个候选，不提前实现并行队列。

### 3.7 Preflight 与隔离副本

启动前汇总：

```text
TaskCase              hash verified
Historical baseline   available
Recovered environment partial · 1 limitation
Runtime                Codex <version>
Candidate              requested → resolved
Run-local config       supported
Isolation              creatable
Original workspace     untouched

[Enter] Prepare and start   [b] Back
```

点击一次后才创建新的 Experiment、RunAttempt 和隔离副本，注入 run-local Candidate 配置并再次 fingerprint。Preflight 只做低成本只读检查；失败必须发生在 Candidate 启动前并指出具体条件。

### 3.8 Candidate 在原 Agent 产品中运行

Candidate 必须通过所选 Product Pack 的 RuntimePort 在原产品中执行，例如 Codex app-server。Reprise 不能绕过 Codex 直接调用模型 API，否则比较对象已经改变。

Running 页显示 HARNESS、TARGET、CONTROLLER 单一主时间线，并支持：

- `↑/↓` 选事件，详情区显示完整公开内容；
- `PgUp/PgDn` 滚动，`End` 回到最新；
- `f` 过滤 `ALL/TARGET/CONTROLLER/HARNESS`；
- `x` 确认取消，继续显示 stop 和 cleanup；
- 用户向上滚动后不强制跳回末尾；
- output delta 节流渲染，完整事实仍持久化；
- 运行中 `q` 不得静默遗留后台实验。

可以显示公开回复、plan、工具、命令、输出和文件变化；不声称展示隐藏 reasoning。等待模型时只更新 elapsed 和阶段，不制造虚假“思考”事件。

### 3.9 Controller 动态后续输入

每个 Candidate turn settle 后，Controller 根据 TaskCase、当前轨迹、产物、先前决定、预算和 fidelity 返回：

```text
SEND(message)  发送明确的下一条用户输入
DONE(reason)   不再发送消息：已满足、阻塞、需要真实用户决定或无进一步价值
```

必须持久化 evaluation、decision/rationale、实际发送文本、delivery、settlement 和 fallback diagnostic。

当前真实 runner 只允许一次 follow-up。正式实现改为受 `RunPolicy.maxTargetTurns`、wall clock 和 no-progress 限制的循环，复用 `CandidateRun.submit()`，不建立第二套 turn 状态机。

Controller 不能批准权限，也不能代替用户做付款、发布、账号或破坏性决定；遇到边界应 `DONE(requires_real_user_decision)`。Runtime 的实际停止和清理由 Orchestrator 执行。

### 3.10 Comparison 与用户判断

Candidate 终止并完成 cleanup 后，Comparison Agent 整理：

- 原始历史结果与 baseline；
- Candidate RunRecord、产物、patch、测试和范围审计；
- Controller 决策轨迹；
- token、时长、turn、工具和错误遥测；
- environment fidelity、runtime drift 和 fallback diagnostics。

TUI 结果页摘要展示历史结果、候选结果、轨迹、环境、Controller/Comparison fallback 和报告路径。

本地 HTML 并排报告展示：

- 原始结果与候选结果；
- 文件、patch 和测试产物；
- 时间线与 Controller 实际输入；
- 效率/成本遥测；
- runtime/model/environment 差异；
- fallback、限制和证据引用。

Comparison 不生成不可审计的“客观总分”。最终判断属于用户。

## 4. 生命周期、安全与错误

### 4.1 入口

先提供：

```powershell
reprise tui
```

验收稳定后，交互式 TTY 中无子命令 `reprise` 可直接进入 TUI；`--help`、现有脚本化子命令和非 TTY 行为保持明确。

### 4.2 取消和终端恢复

- Setup/选择页退出：直接恢复终端；
- freeze/recovery 退出：使用 `AbortSignal` 取消 staging，已完整提交的不可变事实保留；
- Candidate 运行中退出：经 `CandidateRun.cancel()`，等待 runtime stop、RunRecord 和 workspace release；
- Comparison 中退出：首版等待或取消，不假装支持可恢复后台 job；
- 所有路径通过 `finally` 恢复 alternate screen 和光标；
- TUI 不直接 kill 子进程或删除目录。

### 4.3 错误归属

- Pi 配置错误回 Setup；
- Product 未安装回产品页；
- 会话解析/隐私错误留在会话页；
- freeze 失败不产生完整 TaskCase；
- Recovery unavailable 禁止启动；
- runtime 错误完成 cleanup 后展示 experiment 目录；
- Controller/Comparison 错误显示结构化 fallback diagnostic；
- 打开报告失败不改变已持久化的 `comparison.md`、薄信封或 Host 事实。

## 5. 架构与现状差距

### 5.1 依赖方向

```text
TUI / CLI
  ↓ user intent
Application workflow
  ├─ Pi configuration
  ├─ Product Pack: installation / sessions / freeze / models / RuntimePort
  ├─ RecoveryAgent → EnvironmentProvider validation
  ├─ CandidateRun ↔ Controller loop
  └─ ComparisonAgent → report
                   ↓
             ExperimentStore
                   ↓
        timeline/result projection
                   ↓
                  TUI
```

TUI 不被 Store、Agent、Environment 或 Runtime 反向依赖；HTML 与 TUI 读取同一持久化事实。

### 5.2 已有能力

- `PiAgentHost` 与 Recovery/Controller/Comparison Agent；
- Product Pack registry；
- Codex fixture freeze 与 RuntimePort；
- CandidateRun start/submit/cancel/complete；
- LocalWorkspaceProvider；
- ExperimentStore observer 和 replay；
- timeline projection 与 HTML report；
- 已安装 `pi-tui` 组件。

### 5.3 需要补齐

- 首次 Pi 配置和验证；
- Codex 安装探测与真实会话发现；
- 完整会话冻结和隐私边界；
- Recovery 与 Provider 的正式编排；
- 目标 Runtime 候选发现/验证；
- 可取消的真实 Experiment handle；
- 多轮 Controller 循环；
- Comparison 完整诊断和并排投影；
- 全屏可操作 TUI 与正式 CLI 入口。

### 5.4 最小接口演进

Codex 实证后，Product Pack 最多需要这些能力：安装探测、会话发现/检查/冻结、候选发现/验证和 RuntimePort。优先复用现有函数，不为了接口示意包装 class；只有第二个 Product Pack 真正需要时才提升公共 contract。

准备操作直接接受标准 `AbortSignal`。Candidate 运行只需要具体句柄：

```ts
type ExperimentHandle = {
  result: Promise<ExperimentResult>;
  cancel(): Promise<void>;
};
```

真实 runner 从 `scripts/` 收敛到可发布 application workflow；smoke 和历史脚本只做薄调用，不复制编排。

### 5.5 TUI 文件边界

先用一个 `src/tui/app.ts` 管理页面、焦点和按键，复用 `timeline.ts`。不要预建九个页面 class；只有文件实际超过可读范围时再按职责拆分。

新 TUI 覆盖运行页后：

- 删除旧 `LiveTimelineTui` 用户入口；
- 保留 protocol smoke，但不把它当用户入口或 benchmark；
- 不维护 `--tui` monitor 与 `reprise tui` 两套产品路径。

## 6. 分阶段实施

### P1：Pi 配置与 Product 选择

实现 alternate-screen 应用壳、Pi 默认模型配置/验证、Product Pack 列表和 Codex executable/version 探测。

完成：新 data directory 先进入 Setup；保存 Terra/medium 后进入 Products；再次启动不重复向导；退出可靠恢复终端。

### P2：Codex 会话发现与 TaskCase 冻结

实现真实会话只读扫描、高价值信号、session inspection、隐私检查和 immutable freeze；fixture 覆盖 schema 漂移与损坏数据。

完成：用户选择一段真实会话并得到 hash 稳定、可重开的完整 TaskCase；原 `.codex` 数据未修改。

### P3：Recovery、Environment 与 Runtime 解析

从 TaskCase 生成 RecoveryContext，调用 Terra/medium Recovery，执行 Provider staging/fingerprint，记录当前 Codex executable/version/capabilities 和 fidelity。

完成：`full/partial/unavailable` 均有持久化事实和 TUI 解释；原仓库未修改，fallback 不被伪装成成功。

### P4：候选、Preflight 与隔离

实现 Codex 候选发现/验证、Luna/high 默认值、requested/resolved model、运行条件汇总和按需创建隔离副本。

完成：无效模型或环境在 Candidate 启动前失败；有效配置不写全局 Codex 设置，并生成新的不可覆盖 experiment/run ID。

### P5：真实 Candidate、动态 Controller 与 Live TUI

将真实 runner 收敛到 application workflow；接 Store timeline；实现浏览、过滤、详情、节流、安全 cancel；Controller 按 RunPolicy 循环 `SEND/DONE`；强制停止由 Orchestrator 处理。

完成：Luna/high 在真实 Codex Runtime 执行；Terra/medium Controller 可根据轨迹结束或发送后续输入；所有实际输入、settlement、fallback 和 cleanup 可 replay。

### P6：Comparison、摘要与并排报告

Comparison 读取历史结果、Candidate 产物和遥测；持久化诊断；生成 TUI 摘要和本地 side-by-side HTML。

完成：TUI 与报告引用同一事实，完整展示结果、过程、效率、环境限制和证据，让用户自行判断。

### P7：真实用户验收

选择新的中等任务量 Codex 历史会话跑完整流程。只修复真实暴露的会话 schema、长输出、resize、等待响应、Ctrl+C、runtime drift、workspace lock 和报告打开问题。

完成后停止；是否用 Claude Code 验证 Product Pack contract 由用户决定。

## 7. 测试与工程纪律

### 7.1 确定性测试

- 首次/再次启动配置；
- Product 安装探测；
- 会话排序、过滤、损坏输入和隐私拒绝；
- TaskCase hash 与 immutable write；
- Recovery fallback 和 Provider validation；
- candidate requested/resolved model；
- Controller `SEND → submit → settle → DONE`；
- cancel 幂等、竞态和 cleanup；
- Comparison fallback 与报告投影。

### 7.2 TUI 键盘流

使用 fake Pi、Product Pack、Environment Provider 和 Runtime 驱动完整页面路径，捕获 render 并验证：焦点/返回、滚动跟随、filter、详情、cancel、最后一帧和 terminal restore。不引入 UI 测试框架。

### 7.3 一次真实验收

真实模型调用不放默认测试套件。使用用户明确选择的历史会话和绝对 data directory，固定 Luna/high 与 Terra/medium，检查：

- session ref、TaskCase hash；
- Recovery/Environment fidelity；
- Runtime executable/version；
- requested/resolved model；
- Controller 每轮决定和实际输入；
- Candidate artifacts/tests/scope；
- Comparison/fallback；
- JSONL sequence 连续且 replay 成功；
- cleanup complete；
- TUI 摘要与 HTML 一致；
- 原 `.codex`、原仓库和全局 Codex 配置未变化。

### 7.4 构建与 Git

纯文档不构建、不测试。每个代码任务最多构建一次，只跑直接受影响测试；随后执行 `git diff --check` 和 Ponytail review。不自动 commit/push，不提交 docs、历史 runner、会话、冻结源码或实验产物。

## 8. 总体验收标准（Done-means）

- [ ] 首次使用通过 Pi 配置 Harness 内部 Agent 默认模型；
- [ ] 选择已安装目标 Agent 产品并看到 executable/version；
- [ ] 发现、检查并选择真实高价值历史会话；
- [ ] 完整会话不可变冻结为 TaskCase；
- [ ] Recovery Agent 与 Environment Provider 恢复并验证会话开始前环境；
- [ ] fidelity、缺口和当前 Runtime 信息可见且落盘；
- [ ] 候选来自目标 Runtime 已配置或可验证模型；
- [ ] preflight 后只创建隔离副本，不修改原环境；
- [ ] Candidate 在原 Agent 产品 Runtime 中运行；
- [ ] Controller 按轨迹执行受限多轮 `SEND/DONE`；
- [ ] TUI 可浏览公开过程、滚动、过滤、看详情并安全取消；
- [ ] Comparison 整理历史结果、候选产物和过程遥测；
- [ ] TUI 摘要与本地并排报告引用同一事实；
- [ ] 用户看到限制/fallback 并自行判断；
- [ ] trace 可 replay、sequence 连续、RunRecord 和 cleanup 完整；
- [ ] 所有退出路径恢复终端且不遗留进程或 workspace lock；
- [ ] 没有新增依赖、第二套凭据、runner 或状态机；
- [ ] Ponytail 审查无可删除的推测性抽象。

## 9. 推荐顺序

```text
P1  Pi 配置 + Product 选择
→ P2  Codex 会话发现 + TaskCase 冻结
→ P3  Recovery + Environment + Runtime 解析
→ P4  Candidate + preflight + 隔离
→ P5  原产品 Candidate + 动态 Controller + Live TUI
→ P6  Comparison + TUI 摘要 + 并排报告
→ P7  新历史会话真实验收
```

该顺序严格对应真实用户流程。先完成 Codex 全纵切片，再决定是否以 Claude Code 验证和扩展 Product Pack contract。
