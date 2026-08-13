# Reprise v0.1.0：Claude Code 风格 Benchmark TUI 工作台重构规划

> 状态：已完成第一性原理收缩；实现仍在进行，最终验收未完成。
> 日期：2026-08-12
> 取代范围：本规划取代 `reprise-interactive-tui-plan.md` 中“启动即设置 → 产品选择 → 历史会话导入”的向导式交互方案；旧文档保留为历史设计依据。
> 设计依据：[当前实现偏差分析与系统修正方案](../analysis/current-implementation-gap-and-correction-plan.md)、[三个 Agent 的职责、能力与 System Prompt 对齐稿](../architecture/agent-roles-and-system-prompts.md)、现有 Product Pack / Experiment / TUI 设计文档，以及用户提供的 Claude Code 风格终端参考图。

## 1. 决策摘要

Reprise 的核心不是一个会在当前工作区直接改代码的通用 Coding Agent，而是一个**本地优先的 Benchmark 工作台**：用户把已完成或正在分析的历史 Agent 会话冻结为 `TaskCase`，让候选模型在隔离环境中重放，最后以可审计的证据、运行事实和 Comparison 叙述进行比较。

本次重构只改变用户面对系统的入口和交互组织方式，不推翻 canonical 的 Agent / Host / Candidate 隔离契约：

- 从“逐页完成 setup 和 intake 的工具”变成“常驻、命令优先的终端工作台”；
- 以 Claude Code / Codex 的信息层次、编辑器体验、状态栏和渐进披露为交互参考，**不复制其品牌、logo、文案或私有行为**；
- 启动时始终进入 Home，而非强迫用户先配置 Provider 或导入会话；
- 用 `/config` 显式配置 Harness Agent 使用的 OpenAI-compatible API、Base URL、模型、effort 和安全的密钥引用；
- 用 `/intake` 按需进入 Codex 历史会话导入；用 `/run` 明确启动已选 TaskCase 的实验；
- 维持 Recovery、Controller、Comparison 的既有职责、工具边界、证据链与 Host facts，TUI 只消费和发起这些能力，不能伪造模型活动或领域结论。

### 1.1 成功定义

用户在项目根目录执行 `reprise tui` 后，可以不离开该应用、只用键盘完成下列流程：

1. 看到项目、模型/effort、API 状态和最近实验，而不是 Setup 死路；
2. 输入 `/config` 配置第三方 OpenAI-compatible endpoint，且 API key 不写入 Reprise 数据文件；
3. 输入 `/intake` 导入 Codex 会话并冻结为可复查的 TaskCase；
4. 输入 `/run` 对已选 TaskCase 发起隔离实验，实时看见 Host 已确认的阶段和事件；
5. 输入 `/history` 回看实验、选择 case，并从详情打开报告；
6. 任何取消、配置失败、窄终端、无可用 TaskCase 或无 API 凭据都得到可恢复、可解释的界面，而不是崩溃、空白页或误报成功。

### 1.2 非目标与硬边界

- 不把无斜杠自然语言输入交给模型并让它修改用户当前工作区；这会混淆 Benchmark 与通用 coding agent 的产品边界。
- 不新建第二套 Agent runtime、工作流引擎、事件存储、凭据库或 UI 框架；优先复用 `@earendil-works/pi-tui`、Pi、现有 Store、RuntimePort、CandidateRun 和报告投影。
- 不改变 Recovery 仅写 staging、Controller/Comparison 只读、Candidate 隔离运行、Host 记录事实的 canonical 权限模型。
- 不在本阶段新增 Claude Code Product Pack；首个完整纵切片仍为 Codex intake。UI 文案可以保留可扩展的 Product Pack 概念，但不得展示不可用功能。
- 不自动发送实验、自动进行真实 provider 探针或自动读取会话。涉及网络调用和费用的动作必须由用户明确确认。
- 不保存、显示、记录或导出 API key、Authorization header、带凭据 URL、完整敏感环境变量或未经 privacy policy 允许的模型输入。

## 2. 现状、问题与重构原则

当前 `src/tui/codex-intake.ts` 采用 `loading → setup → product → sessions → inspection → …` 的多页向导状态机。首次运行会把用户送到 Pi provider/model/effort 配置页；截图中的 “Pi has no usable credential” 使用户停在这里，且界面没有 `/config`、最近实验、当前 TaskCase 或可发现的下一步。这与用户期望的常驻型终端应用相反。

现有 `HarnessModelConfig` 只保存 `providerId`、`modelId`、`effort` 和可选 `baseUrl`，`PiModelCaller` 又依赖 Pi catalog / `getAuth`。这足以支撑内置 provider，却没有形成用户可理解的第三方 OpenAI-compatible 配置契约，也没有安全的密钥引用字段。

重构遵循以下原则：

1. **Home first**：配置缺失是状态，不是页面入口；任何时候都能回 Home。
2. **命令优先、表单按需**：`/` 调出发现性命令；需要多字段输入时使用内嵌 sheet/modal，不让用户在一长串页面间跳转。
3. **本地状态最小化**：`.reprise/`（或 `REPRISE_DATA_DIR`）只保存运行所需的非敏感状态；不为尚无执行消费者的项目说明文件新增持久化概念。
4. **渐进披露**：首页只显示近期、可行动的信息；证据、trace 和原始会话通过详情页或展开项按需读取。
5. **事实优先**：运行时间线显示 Host 已记录的 stage/event；模型叙述、Controller 动作、Comparison 结论与 Host facts 明确区分。
6. **键盘可达和可恢复**：所有状态至少提供 Escape 返回、`Ctrl+C` 取消/退出的清晰语义、帮助、错误原因和下一步。
7. **先验证 Pi 能力再落实现**：第三方 provider 适配不得猜测 Pi 的 custom-provider 写入 API；先完成依赖类型和最小 probe 的 spike，选择最小可复用路径。

## 3. 信息架构与主视图

### 3.1 全局 Shell

`reprise tui` 打开一个 alternate screen 应用，退出时必须恢复原终端。顶栏、当前视图、composer 和状态栏是常驻区域；当前视图可以切换为配置、导入、历史或运行流程，但不应退化为启动即 setup 的线性 wizard。

```text
Reprise v0.1.0 · C:\work\my-project                 gpt-… · high
┌────────────────────────── Welcome / Recent runs ──────────────────────────┐
│ Welcome back                                                               │
│                                                                            │
│ /config    配置 OpenAI-compatible API、Base URL、模型与密钥引用            │
│ /intake    导入 Codex 历史会话                                             │
│ /run       对当前 TaskCase 执行实验                                        │
│ /history   浏览最近 TaskCase / experiment                                  │
│                                                                            │
│ 当前 TaskCase：未选择   最近实验：无                                       │
└───────────────────────────────────────────────────────────────────────────┘

> 输入 / 命令…
────────────────────────────────────────────────────────────────────────────
● API 未配置 · 无当前 TaskCase · 当前项目 · /help
```

- 顶栏左侧：版本、启动目录的安全缩略形式；右侧：已保存的 Harness 模型与 effort。没有有效本地配置时显示 `未配置模型`，不得把代码默认值伪装成用户已配置的模型。
- 主区：首页为 Welcome / Recent runs 卡片；有历史时显示最近 3–5 条，不淹没信息。运行时显示 Host facts timeline；配置、导入和历史各使用其最小专用视图。无需为 v0.1.0 实现跨流程的 transcript 回放或消息日志。
- Composer：唯一文本输入焦点，支持行内编辑、粘贴与提交；v0.1.0 不保存输入历史。
- 底栏：以彩色点和可读文本组合显示本地配置状态、当前 TaskCase、项目、当前可用的帮助；色彩不能作为唯一信息来源。`已配置` 仅表示本地 schema 与密钥引用可用，不能暗示网络连通性已经验证。
- 不渲染假的 token 流、工具输出、检查通过或模型 thinking。未知即显示“尚未检查”或“不适用”。

### 3.2 运行中的主视图

`/run` 完成确认后进入可返回的运行视图，而不是黑箱页面；运行事实来自现有 Host / Store，composer 不接受自然语言任务：

```text
Run exp_20260812_… · TaskCase case_… · Codex / gpt-…
  ✓ 基线恢复已冻结（Host verified）
  ✓ Candidate 隔离副本已创建
  ● Controller turn 2 已发送；等待 Candidate runtime
  · Comparison 尚未开始

> Ctrl+C 可请求停止；运行事实见时间线
────────────────────────────────────────────────────────────────────────────
● 运行中 · Ctrl+C 请求取消 · TaskCase case_…
```

仅 Host 已观测到的事件可打勾。模型返回的叙述应标注“Agent 输出”；等待、失败、取消、delivery unknown、runtime failure 必须直接使用 canonical 生命周期状态，不能映射成 `done` 或“成功”。

### 3.3 详情与窄终端

- `/history` 打开 runs / TaskCases 列表；Enter 展开详情，TaskCase 详情中 Enter 设为当前 case，Esc 回到上一视图。run 详情只展示经校验的报告路径和事实摘要；v0.1.0 不自动打开外部程序或读取报告原文。
- 长字段截断时使用 `…`，详情中允许横向或分页显示，不能静默丢失路径、错误或状态。
- 若列宽小于约 72 个单元格，使用单列布局：顶栏缩写、隐藏装饰边框、正文保留完整状态；小于最低可用宽度时显示明确要求扩宽终端的 fallback，而不是错位渲染。
- Unicode box drawing 不可用或终端声明不支持颜色时，降级为 ASCII 边框/无色文本，信息架构不变。

## 4. 命令与输入契约

### 4.1 第一性原理与命令边界

TUI 的最小目标是让用户完成 `配置 → 导入 → 运行 → 回看`，不是模拟通用 Agent 的聊天界面。只有**进入一个独立且有副作用边界的流程**才值得成为 slash 命令：配置、导入、运行和浏览持久结果；`/help` 只解决发现性。列表选择、详情返回、取消与退出都由当前视图的标准按键完成，不能再包一层命令。

`TaskCase` 是唯一的运行选择状态：它只由 `/intake` 的 freeze 结果或 `/history` 的 TaskCase 详情产生，`/run` 只运行当前 case。`/run [case-id]` 会引入第二个选择入口、参数解析和“当前 case”冲突规则，却不能缩短主闭环；v0.1.0 不实现。

退出、取消、返回和丢弃草稿是界面生命周期操作，不是领域对象：返回与丢弃使用 `Esc`，取消与退出使用 `Ctrl+C`。运行中收到 `Ctrl+C` 即请求取消并等待 Host 终态；如果 Host 无法终态化，TUI 保持打开并显示失败事实，不能静默退出。报告属于 run 详情；v0.1.0 仅显示受允许目录内、经校验的本地报告路径，不新增 `/report` 或外部程序启动。原始 Codex 会话只在导入时浏览，避免 `/history` 承担两种不同的数据模型。

### 4.2 Slash 命令

| 命令 | 必要的用户意图 | 前置条件与确定结果 |
|---|---|---|
| `/help` | 在任意位置重新发现闭环和按键 | 永远可用；只显示本地静态帮助，不读 session、不调用网络。 |
| `/config` | 编辑 Harness 的连接配置 | 打开可丢弃的本地草稿；保存仅做 schema、URL 与 `keyRef` 校验；只有用户选择测试连接才 probe。 |
| `/intake` | 按需浏览并冻结 Codex 历史会话 | 此时才读取本地 session 索引；确认 freeze 成功后设为当前 TaskCase，取消不写半成品。 |
| `/run` | 对当前 TaskCase 发起一次隔离实验 | 先做不联网的本地检查（case、配置、来源目录、runtime）；通过后展示确认页。只有确认启动才创建 experiment、调用 provider 或产生费用。 |
| `/history` | 回看已持久化的 runs / TaskCases | 默认最近 run；TaskCase 详情可设为当前 case，run 详情显示事实摘要和报告路径。 |

命令名大小写不敏感，且都不接受参数。未知命令只提示这五个命令。输入 `/` 时展示候选；Tab 只补全唯一匹配项，Enter 执行，Esc 关闭建议。v0.1.0 不做关键词搜索、命令别名、命令历史、模糊匹配或独立 command-palette 状态。

### 4.3 无斜杠输入

无斜杠输入不是任务描述，也不执行任何动作；它不会被发送给 Harness 模型、Candidate runtime 或写入 TaskCase。v0.1.0 只提示“Reprise 是 Benchmark 工作台；输入 `/help` 查看可用操作”，随后清空 composer。

不做自然语言意图识别、命令推荐或把任意文本转成实验输入：这些能力不缩短 config → intake → run → history 闭环，反而会制造 Reprise 是通用 coding agent 的错误预期。

### 4.4 基础快捷键

| 按键 | 行为 |
|---|---|
| `Enter` | 执行 composer 内容/确认当前选择。 |
| `Esc` | 关闭补全、丢弃未保存草稿或返回上一视图；在 Home 仅清空 composer。 |
| `↑` / `↓` | 在补全或列表中移动；v0.1.0 不保存 composer 输入历史。 |
| `Tab` | 补全唯一的 slash 命令；多个候选保持列表选择。 |
| `Ctrl+C` | 运行中向 Host 请求取消、禁用重复请求并等待终态；其他状态退出并恢复终端。不得留下孤儿后台运行；未提交 composer 文本不保存。 |
| `?` | composer 为空且不在表单内时显示 `/help`。 |

## 5. 配置与凭据安全

### 5.1 最小持久化边界

除已有的 TaskCase / experiment 存储外，v0.1.0 只有一个新增且必要的本地配置文件：`<dataDir>/harness-model.json`。它保存 schema、provider kind/id、model id、effort、无凭据 base URL 与 `keyRef`；不得保存 API key、Authorization、带凭据 URL、probe payload 或密钥环境变量值。

API key 的真实值只存在于用户已配置的环境变量（或 Pi 已支持的凭据来源）。Experiment Store / manifest 只记录用于可重放的非敏感模型标识、effort 与 policy hash；不得记录 key、secret 值或未经 privacy policy 允许的内容。

不在 v0.1.0 引入 `REPRISE.md` 或 `/init`：当前实验编排没有读取它的执行消费者，项目说明也不构成完成 intake/run 闭环的前置条件。未来若需要团队共享、可被明确读取的项目级 benchmark policy，再以具体消费者、覆盖规则和最小 schema 单独设计。
### 5.2 v0.1.0 配置 schema（目标）

现有 schema v1 需要迁移为 v2，并保留 v1 无损读取。建议的持久化形状如下；字段最终命名必须以 Pi spike 和现有 TypeScript 风格为准：

```json
{
  "schemaVersion": 2,
  "provider": {
    "kind": "pi-catalog",
    "id": "openai-codex"
  },
  "modelId": "gpt-5.6-terra",
  "effort": "high",
  "baseUrl": "https://api.example.com/v1",
  "keyRef": "env:REPRISE_API_KEY"
}
```

- `provider.kind` 只能是经实现支持的 `pi-catalog` 或 `openai-compatible`；不得以自由字符串暗示任意适配器已经可用。
- `provider.id`、`modelId` 限制长度和字符集；`effort` 限定 Pi 支持的集合。
- `baseUrl` 必须是 `https:` 的绝对 URL，无 username/password、query、fragment；开发环境例外若允许 `http://localhost`，必须显式 opt-in，禁止泛化为任意 HTTP。
- `keyRef` 初版只接受 `env:NAME` 或 `${NAME}`，其中 `NAME` 符合环境变量名称规则。保存前只显示名称，例如 `env:REPRISE_API_KEY`，绝不显示变量值。
- 没有 `keyRef` 的 Pi catalog provider 允许继续使用 Pi 已支持的认证发现方式；OpenAI-compatible provider 必须具备可解析的 `keyRef`。
- `/config` 中“保存”只做 schema/安全/环境引用存在性验证；“测试连接”是单独的、带说明的显式操作，使用最小文本请求和短超时，结果不持久化原始响应。
- 迁移 v1 时构造 `provider.kind: pi-catalog`，保留 provider/model/effort/baseUrl；因为旧配置没有 keyRef，显示“使用 Pi 凭据发现”，不自动写新文件，直到用户确认保存。

### 5.3 `/config` 交互

配置 sheet 采用小步、可撤销字段编辑，而不是启动向导：

```text
/config · Harness API
Provider type     OpenAI-compatible
Provider label    my-gateway
Base URL          https://api.example.com/v1
Model             gpt-…
Effort            high
API key reference env:REPRISE_API_KEY  [已找到，不显示值]

[Enter] Save   [t] Test connection   [Esc] Discard
```

- 内置 Pi catalog 路径可显示 provider/model 选择器；OpenAI-compatible 路径接受受限文本输入，不能假装其模型都可自动发现。
- 修改值只保存在内存草稿，按 Esc 丢弃；保存前逐项定位错误。
- 如果环境变量不存在，提示设置命令的**变量名**示例，不显示或记录任何值。
- base URL、错误消息和 provider 返回文本进入日志/Store 前都须走敏感信息清洗；URL 不能因为异常路径绕开验证。

### 5.4 Pi 适配 spike（实现前阻塞项）

必须先用本地已安装的 Pi 类型声明、源码/官方文档和一个不含真实 key 的测试 double 验证以下问题：

1. Pi 如何注册或构造 OpenAI-compatible/custom provider 与 model；
2. 如何把 `keyRef` 解析后的 key 只交给 Pi 请求层，而不写入 Models、配置或 trace；
3. base URL 覆盖、认证、reasoning/effort 映射、超时和 abort 在该路径中的真实 API；
4. catalog provider 与 custom provider 的错误分类和最小 probe 行为。

若 Pi 没有安全且可复用的 custom-provider API，则停止该子功能的实现并重新决策；不能通过把 key 拼进 URL、伪造 `getAuth` 或新建不受审计的 HTTP caller 绕过。

## 6. TaskCase、Intake、Run 与报告流

### 6.1 `/intake`：嵌入而非首页劫持

`/intake` 将现有 Codex intake/freeze 能力作为一个可返回的 flow 嵌入 Shell：选择本地会话源 → 搜索/筛选 → 检查摘要和隐私 → 确认冻结。退出或失败返回此前 transcript/Home，并保留解释性消息。它不得在启动时自动扫描、上传或冻结会话。

完成时主区追加：TaskCase id、简短任务摘要、来源产品、冻结时间、是否可运行；底栏切换为当前 TaskCase。完整原始会话仍受 privacy policy 和现有脱敏约束，默认不全部展开。

### 6.2 `/run`：清晰的预检与确认

`/run` 的顺序固定为：

1. 解析并选择 TaskCase；
2. 校验 Harness 模型配置（非敏感字段）与 key reference；
3. 运行不联网的本地 preflight：来源目录、Runtime 可执行性、环境条件和候选静态配置。它不得 probe provider、列远程模型或创建 experiment；
4. 展示来源目录、产品、候选模型/effort、会调用的 Harness Agent、隔离目录策略、privacy policy、预期费用和已知阻塞项。来源目录可从启动目录预填，但必须在此屏清晰可见且由用户确认；不得从历史会话悄悄推断另一个目录；
5. 用户明确确认后才创建 experiment、调用 provider 或进行其它网络操作；
6. 订阅 Store / orchestrator 已有事件，投影为 timeline；
7. 完成后显示事实摘要、报告位置和后续命令。

“API 测试通过”不等于 `/run` 可运行；“Controller done”不等于成功；“Comparison markdown 存在”不等于 baseline/candidate match。这些必须按 canonical Host facts 显示。

### 6.3 `/history` 与可审计性

- `/history`：默认最近 run；列表可切换至 TaskCase，不另设命令。run 详情显示 TaskCase、候选、终态、开始时间与报告入口；case 详情可设为当前 case。Codex 原始会话只在 `/intake` 中浏览。
- report 是 run 详情的操作：复用报告 renderer 或打开本地路径；TUI 摘要仅展示人可理解的结论和 Host facts。缺失 Comparison narrative、验证失败或证据不可用都必须显式标注。
- 任意报告/历史详情中的路径只可在受允许的项目/data 目录内解析；渲染原文时复用现有 privacy/redaction policy。

## 7. 状态、错误与取消模型

状态设计只需表达当前流程和正在进行的 run，不创建 command-palette、overlay 或第二套状态管理框架。实现可用一个根部 `mode`（`home | config | intake | history | run | running`）以及少量局部选择状态；详情是 history/intake 的局部状态，错误是可返回的消息，不必成为全局页面类型。

关键转换：

- 启动：`home`，异步读取项目、轻量配置摘要和最近索引；加载失败仍留在 `home` 并显示可重试错误。
- `/config`、`/intake`、`/history` 可在未配置时进入；退出均回到调用前的 Shell。
- `/run` 只有本地预检完成才进入确认；确认后进入 `running`，拒绝后回 Home。
- `Ctrl+C` 在 `running` 内产生 `cancellationRequested`，禁用重复请求，等待 Host 终态事实；不得本地直接断言运行已取消，也不得在终态前关闭 TUI。
- 任意可恢复错误是带可执行下一步的 transcript 消息；不可吞掉异常或编造诊断 id。
- exit：无运行直接退出；有运行时 `Ctrl+C` 只请求取消并等待终态，随后再退出。退出时停止 TUI 订阅、恢复 raw mode/alternate screen，不能留下未处理 rejection 或孤儿后台运行。

## 8. 实施路线（按最小纵切片）

### P0：契约冻结和低风险准备

**产物**：本规划、命令表、文本 wireframe、配置 v2 设计、迁移/测试矩阵。
**动作**：给旧向导式规划添加“已由本规划替代”的链接；盘点 `@earendil-works/pi-tui` 的可复用输入、viewport、alt-screen、键盘能力；完成 Pi custom-provider spike。
**Done means**：有测试 double 证明支持路径与 key 不落盘的边界；若不支持，形成明确 blocked decision，而不是开始 UI 实现。

### P1：Workspace Shell 与命令路由

**范围**：保留 `reprise tui` CLI 兼容，替换默认启动视图为 Home；实现顶栏、transcript、composer、状态栏、五个最小命令的 parser/补全、`Ctrl+C` 退出/取消、窄终端 fallback。命令 router 只分派这五个流程，不引入通用命令框架。
**不做**：运行真实模型、改动 Agent/Host 契约。
**Done means**：无任何配置和会话时启动可用；脚本化键盘流验证 Home、help、未知命令、Esc、Ctrl+C 和终端恢复。

### P2：配置

**范围**：`/config`，配置 v2 读写/迁移、keyRef 验证、Pi catalog 选择和已验证的 OpenAI-compatible 适配。
**Done means**：v1 配置仍可读取；明文 key/credential URL 被拒绝；保存后的文件不含 key；显式 probe 的成功/失败在 UI 中可恢复。

### P3：Intake 嵌入

**范围**：将现有 Codex session 索引、检查和 freeze workflow 接入 `/intake`；保留现有私密性、脱敏和 TaskCase 不可变性。
**Done means**：键盘流从 Home 进入、筛选、冻结、返回 Home，并显示当前 TaskCase；取消不产生半成品 TaskCase。

### P4：Run、实时投影与取消

**范围**：`/run` preflight/确认、订阅实验事实、running/result 视图、Ctrl+C 取消、错误投影。
**Done means**：fake Runtime + fake Agent Host 集成测试验证确认前不调用模型、各 terminal 状态准确显示、取消不伪造 Controller `done`、TUI 退出后终端恢复。

### P5：历史、报告和渐进披露

**范围**：`/history` 的 runs / TaskCases 列表与详情、报告路径和 Host facts 摘要的安全展示。v0.1.0 不做 session 历史、报告全文渲染、全文搜索、过滤语法或外部打开器。
**Done means**：多个 TaskCase / experiment 可导航；缺失 narrative、失败、privacy 限制和终态事实均可见；不意外读取或渲染超出 policy 的内容。

### P6：迁移、删除和真实验收

**范围**：删除不可达的 setup-first 入口、过期 Page 分支和重复模型表单；更新 CLI help、README/用户文档；opt-in 真 provider smoke。
**Done means**：不再有启动即 setup/product/session wizard；Codex 真实会话可从 `/intake` 完成一次明确授权的端到端实验；文档和实现命令一致。

每阶段完成后先停下复核范围，不与后续阶段并行堆叠。若新增代码超过现有文件的合理规模，应按 Shell、command router、config sheet、intake adapter、run projection 分文件拆分；单文件不得超过仓库约束的 1000 行。

## 9. 验收与测试矩阵

| 类别 | 场景 | 关键断言 |
|---|---|---|
| 启动 | 无配置、无 case、无 session | 进入 Home，不进入 setup；显示 `/config`、`/intake` 和准确状态。 |
| 输入 | `/` 补全、未知命令、自然语言 | 只识别五个无参数命令；可导航/可解释；自然语言清空后绝不调用模型或写工作区。 |
| 配置安全 | key 明文、credential URL、无效 env 引用 | 全部拒绝；保存、日志、错误、report 中均没有 secret。 |
| 迁移 | 现有 schema v1 配置 | 无损读取并以 catalog provider 模式展示；仅显式保存时转 v2。 |
| OpenAI-compatible | 合法 URL/keyRef/model、probe 成功/失败 | 使用已验证 Pi 路径；短超时；错误可恢复且不泄漏。 |
| intake | 索引、筛选、freeze、取消 | 从 Home 返回；TaskCase 不可变；取消无半成品。 |
| run | 本地 preflight、确认、terminal states | 本地 preflight 不联网且不创建 experiment；未确认前无真实调用；Host facts 正确投影；不把 `done` 当成功。 |
| 取消/退出 | Ctrl+C、运行中退出 | 只请求取消并等待终态；raw mode / alternate screen 恢复。 |
| 历史/报告 | 多 run、缺失 narrative、privacy 限制 | 可发现、可区分事实/叙述；只显示受允许目录内的报告路径和摘要，不越权读取证据或启动外部程序。 |
| 终端兼容 | Windows Terminal / PowerShell、窄宽、无色 | 无错位/崩溃，至少降级到可操作的文本界面。 |
| 回归 | canonical Agent host / experiment / report tests | 不改变 Recovery、Controller、Comparison 和 Host 的既有契约。 |

验证纪律：纯 P0 文档不构建、不跑测试。进入实现后，每个阶段只运行直接受影响的测试；完整构建只在最终集成阶段运行一次。真实 API probe 和真实实验均为用户明确触发的 opt-in，不放入默认 CI。

## 10. 风险、决策闸门与回滚

| 风险 | 控制措施 | 决策闸门 |
|---|---|---|
| Pi custom provider API 与预期不同 | 先做类型/源码 spike 和 test double；不猜测 API | P0 未确认则 P2 仅交付 catalog 配置，第三方 API 标记 blocked。 |
| 密钥泄漏到文件、事件或错误 | 仅 keyRef 持久化；统一验证/清洗；针对泄漏路径写负向测试 | 未通过 “secret never persisted” 测试不得合入 P2。 |
| TUI 重构误伤实验契约 | Shell 只调用既有 application ports；对 terminal states 写集成测试 | P4 前冻结既有 Host/Orchestrator API，不在 UI 中复制领域逻辑。 |
| 真实运行费用或误触发 | `/run` 二段确认；probe 独立动作；状态栏明确显示 | 无确认不创建 experiment / 网络请求。 |
| Windows 终端 ANSI/尺寸差异 | 复用 Pi TUI；最小宽度降级；手工 PowerShell 验收 | P1 必须有无色/窄宽 fallback。 |
| 旧向导残留导致双入口 | 一个 `reprise tui` 默认 Shell；旧流程只作为 `/intake` adapter | P6 删除不可达状态和重复表单。 |

回滚策略：P1–P5 每阶段在同一 CLI 命令下逐步替换，但保留已验证 application 层和数据 schema 读取兼容。若某阶段 UI 发生不可恢复错误，应恢复到 Home 并显示诊断信息，不删除 TaskCase/experiment。schema v2 写入前先确保 v1 reader 不受影响；数据迁移不得批量改写历史文件。

## 11. 文档与实现同步要求

实施开始时需要同步更新：

- 本文的状态、阶段完成项和已验证的 Pi 适配决策；
- `docs/progress/MASTER.md` 的当前目标、阶段、风险和验证证据；
- CLI `--help`、项目 README（如已有用户入口说明）和 `/help` 文案；
- 被替代的 `reprise-interactive-tui-plan.md` 顶部链接，避免后续实现误按旧 setup-first 流程继续堆叠。

任何实现若试图让 Reprise 接管当前工作区编码、存储真实 API key、在未确认时调用网络，或将 Controller/Comparison 输出伪装为 Host facts，均视为偏离本规划与 canonical 架构，必须重新设计而非打补丁。
