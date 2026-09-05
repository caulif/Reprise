# TUI 与最小用户交互规划

状态：当前产品规划

本文定义个人用户从首次配置到查看比较结果的最短路径，以及运行时 TUI 应展示什么。它不规定终端组件库、固定布局或视觉主题；内部状态机、端口和事件协议仍以架构文档为准。

## 1. 设计目标

用户不需要理解 Harness 内部架构，也应能回答：正在比较什么，Harness、Controller 和目标 Runtime 分别在做什么，以及候选结果、效率和可信度有什么差异。当前 TUI 仍不记录完整 token/cost；结果页对不可用的 token 显示 `not recorded`，成本不作精确估算。

界面遵循四条原则：

- **最短主路径**：默认值足够可用，一次 `[准备并开始]` 完成检查、隔离和启动。
- **来源清楚**：Pi 模型与目标 Runtime 中的候选模型始终分开表达。
- **过程可见**：展示类似成熟 CLI Agent 的高信息密度工作过程，而不是只显示 spinner 或最终 JSON。
- **渐进披露**：主时间线保持清晰，工具详情、完整输出和原始记录按需展开。

## 2. 两类模型

Harness 中存在两类不同用途的模型：

- **内部 Agent 模型**：Recovery、Controller 和 Comparison 通过 Pi provider 使用。首次使用时配置一个默认模型，之后可以分别覆盖。
- **候选模型**：由目标 Agent Runtime 实际执行历史任务的被测模型。恢复成功后 TUI 先选已注册 Product Pack，再选该 Pack `RuntimePort.listCatalog()` 给出的模型。列表不是 Pi 内部模型。

候选模型不来自 Pi。确认页只复述已选 `CandidateSpec` 的产品与模型，以及恢复终态一词；解析名与请求名不同时附在候选行。无法可靠解析时显示 `unknown`，不伪造模型事实。

候选配置只写入本次运行的隔离环境。若某个 Runtime 只能通过修改用户全局配置切换模型，第一版将其视为不安全或不支持，不静默修改全局状态。

## 3. 最短用户路径

### 3.1 首次设置

```text
harness setup

配置 Harness 内部 Agent
Provider   OpenAI-compatible
Model      user-selected-model
Status     Connected

Recovery、Controller、Comparison 默认使用此配置
[完成]
```

API key 与 provider 配置复用 Pi，Harness 不建立第二套凭据存储。高级用户之后可以分别覆盖三个内部 Agent 的模型、预算和上下文设置；三个 Agent 的总调用、token 与成本预算默认均不设上限。

### 3.2 每次比较

```text
reprise compare

选择 Agent 产品
→ 选择该产品下的项目
→ 选择该产品的历史会话
→ 自动开始恢复并等待结果（已恢复 / 部分恢复 / 无法恢复）
→ 已恢复或部分恢复：选择候选产品，再选择该 Pack 目录中的模型
→ 确认后创建隔离副本并注入 run-local 配置
→ 运行候选任务
→ 候选结束后选择是否写对照报告（Enter 启动 / s 跳过）
→ 查看结果摘要；跳过时对照为未运行
→ 按需打开本地 HTML 报告和原始详情
```

界面使用“Agent 产品”或“目标 Agent Runtime”，不使用“Agent Harness”；Harness 指当前项目本身。

`/intake` 首先同步展示当前构建静态注册的 Product Pack。它不会在进入页面时解析任何历史目录；用户选择产品后，才调用该 Pack 的会话 Adapter。会话上限、项目分组、搜索、发现失败和进程内缓存均按产品隔离。没有会话、未安装 Runtime 或未配置凭据不会让已注册产品从列表消失；运行前的 preflight 才给出 Runtime 的权威诊断。

### 3.3 选择与准备

```text
选择 Agent 产品
❯ Codex
  Claude Code

选择该产品下的项目和历史会话

会话发现按已安装的 Agent 产品惰性执行：进入产品页后才扫描该 Pack 的配置 root。为保证全局最新活动排序，首屏先完成可取消、有界并发的轻量摘要 index；随后每页展示已发现数、已跳过的本地损坏/排除记录和是否还有下一页，`m` 继续加载，`r` 从第一页刷新。列表不读取完整 transcript，只逐行读取受限的元数据；超限、无权限、损坏 JSONL、无效元数据及不跟随的 symlink/junction 以聚合计数呈现，不展示会话正文或绝对路径。摘要窗口截断只影响展示：`pending` 或残缺摘要仍可 Enter，由核对页做完整 inspect 后再决定能否冻结；不要把窗口里看不到用户消息写成硬 `unreadable`。列表行与项目「最近活动」在首条用户句像指令块（含 `<environment_context>`）时，改用同一摘要窗口里的后续短用户任务句；冻结 `initialInput` 用同一启发式取第一条不像注入指令块的用户任务句，找不到则退回第一条 user 行。摘要窗口截断只截断展示，有可用任务标题的残缺摘要不在列表行标「摘要不完整」；残缺摘要不把未扫描的助手/工具次数写成 `a0 t0`。顶栏空心灯表示未选会话产品（封面且未冻结任务）。产品列表光标所在 Pack 算已选，实心灯。发现页脚把指令、计数和 catalog 全局诊断分行，不在词中截断计数。点选后的状态文案对齐管线：「摘要不完整，正在完整读取」「已冻结，进入环境恢复」「无法恢复：没有合法用户输入」。**会话 Enter 打开核对页（任务起点句）；核对页后续用户轮次用同一启发式去掉注入块；核对页 Enter 才冻结并启动恢复。**进入项目列表时光标优先上次打开的项目，再当前工作区；当前工作区目录若包含 Harness `dataDir`（从本仓库启动）则跳过。确认卡片展示变更条数、第一条未决说明和跳过的 symlink。无合法用户输入不得出现可冻结核对卡，进入错误页。环境检查、symlink/junction 跳过和部分 workspace 都是后台步骤。用户终态只显示「已恢复」「部分恢复」或「无法恢复」，见[会话恢复对用户只暴露终态](../decisions/accepted/2026-08-28-session-recovery-user-first.md)。已恢复或部分恢复后选择候选产品与模型，见[恢复后选择候选产品与模型](../decisions/accepted/2026-09-02-candidate-product-and-model-picker.md)。Recovery Agent 只在 TaskCase 冻结成功之后、且仅在 Provider 创建的候选环境中恢复，不解析产品 JSONL，不写入用户原始 workspace。摘要缺少可靠时间时显示为未知时间，绝不补成 1970 年；只有缺少事件时间时才会使用并标记文件修改时间。产品、root 和 cursor 三者共同界定缓存，因此切换 Agent 或 session root 不会串用会话。TUI 帧审计会为相对时间注入固定渲染时钟，生产交互仍使用系统时钟，因而审计基线不会随日期自然漂移。
❯ 今天 · Reprise · “重新设计插件架构”
  昨天 · web-project · “修复登录页面”

候选产品与模型
恢复完成后列出已注册 Pack（光标默认来源会话产品），再列出所选 Pack 的 `listCatalog`。无法恢复时不到这两页。Enter 只冻结 `CandidateSpec`；启动进程仍在确认页。

运行条件
当前 Runtime            available · auto-recorded
实验内一致性            stable
隔离副本                creatable
候选配置                run-local
预计上限                30 分钟

[准备并开始]
```

进入准备页前只做低成本、只读环境检查。恢复成功后的选产品、选模型是选择，不是计费确认。操作者在确认页按 Enter 后，Harness 才创建候选隔离副本、再次 `validateCandidate` 并启动 Runtime。不要提前创建大量副本。确认页只问费用与「原目录不变、候选读写隔离副本」。变更条数、未决和限额不进确认页。

会影响解释的限制应显示在按钮附近，例如 `environment_partial · 部分外部状态无法恢复`。历史 Runtime 版本与当前版本不同不属于限制；若候选启动前检测到当前 Runtime 发生变化，则显示 `runtime_drift` warning。

## 4. 运行时信息模型

### 4.1 主活动时间线

主界面按照时间顺序投影三种来源，并始终带有来源标签：

- **Harness**：准备环境、启动 Runtime、阶段切换、等待、重试、清理和错误；
- **Controller**：Pi Agent 正常产生的可见 assistant 内容、证据读取、工具活动和最终决定；
- **Target**：目标 Runtime 的可见回复、工具活动、命令、验证和产物变化。

Harness 展示 Controller 的可见工作过程，但不依赖或承诺获取 provider 的隐藏 reasoning token。可见短句来自 `agent.assistant_visible`；如果模型没有产生可见分析，就只展示折叠后的工具活动和最终决定，不额外调用模型伪造摘要。

主时间线不直接倾倒底层 event payload。内部 Agent 的 `agent.tool_*` 按 `payload.role` 分轨：调查类工具合并成「动词 + 对象 + 次数」，变更与 `write` 各占一行，工具 stdout 与上下文 JSON 只经 `[o]`。候选运行宽屏左右分栏：左 Controller（历史回合默认一行折叠），右栏是 Pack 译出的产品可见会话；用户句走 Input 紫，不得画成 Target 青色。两栏独立滚动，滚轮只动焦点栏。窄屏 `Tab` 在两栏全宽之间切换。Comparison 必须先经对照门：Enter 才开绿声部，标题是「正在写对照报告」；跳过则结果页对照为未运行。压缩粒度见[内部 Agent 运行画布](../decisions/accepted/2026-09-01-internal-agent-activity-canvas.md)与[可见短句与显式对照](../decisions/accepted/2026-09-02-visible-process-and-optional-comparison.md)。

恢复页标题绑定 `runPhase==='recovery'`（以及准备态 `preparePhase==='check'`），文案是「正在恢复会话」。该阶段图例是恢复活动，空画布不得写成候选正在写回复。超过 30 秒仍无恢复进展时提示「仍在恢复」，不用候选的「仍在等待本轮结束」。确认后进入候选运行，标题是「候选运行中 · {候选产品}」或「正在启动 {候选产品}」；图例「发给 {产品}」用 `CandidateSpec.productId` 的显示名，不用来源会话产品。用户终态为无法恢复或没有 accept 时，确认页禁止启动隔离候选，标题不得声称已准备隔离对照，原因留一句人话（校验失败时附代码）：变更为 0 时说明没有观察到隔离工作区变更，有变更才强调工作区校验未通过；禁止只显示 `provider_validation_failed`，见[无 accept 的恢复失败不得启动隔离候选](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md)。`partial` 且校验通过的 preview 必须暴露 accept，见[Partial 额外路径](../decisions/accepted/2026-08-30-recovery-partial-extra-paths.md)。运行栏显示当前阶段、最近 Runtime 事件和重连次数；候选阶段超过 30 秒仍无 turn 终态时提示仍在等待，超过 120 秒无新事件时提示可 Ctrl+C。封面、列表、核对、恢复、确认、运行、对照门、对照过程与结果的可滚动区都接鼠标滚轮。候选失败时 `termination.code` 保持 `failed.runtime`，类别与脱敏摘要写在 `failure`；上游暂时不可用由用户重新启动候选，不自动重试。见[候选 Runtime 失败分类](../decisions/accepted/2026-08-28-recovery-candidate-runtime-failure.md)。

### 4.2 决策与实际输入

Controller 的最终决定是一级事件，真正发送给 Target 的内容必须独立突出：

```text
Controller decision · CORRECT
依据：实现接近完成，但测试暴露了共享接口不兼容。

Input to Claude Code
┌─────────────────────────────────────────────────────────────┐
│ 测试失败是因为 adapter 仍使用旧接口。请检查共享调用方，   │
│ 修复根因后重新运行相关测试。                                │
└─────────────────────────────────────────────────────────────┘

Delivered · accepted · target turn 6
```

只有 `ControllerDecision.send.message` 会发送给 Target。同一句投递只画一张 Input 卡：`input.submitted` 与 Pack `prompt` 若正文相同则合并进已有气泡，不叠第二段。Controller 的可见分析、工具参数、`intent`、`rationale` 和证据引用只属于 Harness 记录。Delivery 状态必须来自 Runtime 协议，不能依据界面是否继续活动推测；`unknown`、拒绝和超时应明确显示。

### 4.3 默认显示与按需展开

默认显示：

- 当前任务、候选、实际 resolved model、阶段和经过时间；
- Harness、Controller、Target 的高信息密度活动；
- Controller 决策、完整候选输入和 delivery 状态；
- approval、错误、重试、中断和停止；
- target 与 Controller 分开的少量实时耗时和调用统计；token、成本仅在 Runtime 已记录时显示，否则明确标为 `not recorded`。

按需展开：

- 工具调用参数与结果摘要；
- Controller 读取的原会话片段和候选观察引用；
- Target 命令输出、diff、后台任务和 Runtime 事件；
- 已记录的 token、成本、墙钟时间、调用次数和 Harness trace。

原始详情保留 Pi session、Controller 可见输出、`ControllerDecision`、Runtime transcript、`TraceEvent`、完整命令输出、artifact 和结果文件。默认折叠只影响投影，不影响持久化。

### 4.4 Runtime 详情只读

第一版提供目标 Runtime 的只读事件与详情投影，以及本地报告/trace 打开入口；它不是完整原生会话 UI，也不允许直接输入消息。否则输入会绕过 Controller，破坏 delivery、turn boundary、trace 和“同等人类能力”条件。

未来若支持用户接管，必须记录明确的 `user_intervened` 事实，并终止或降级当前对照语义，不能把人工输入静默混入 Controller 轨迹。


### 4.5 退出、取消与进程中断

第一版不实现后台 daemon 或 detach/reattach。TUI 与 Orchestrator 在同一进程中，但渲染层不是运行事实的所有者：

- 关闭详情页或主 TUI 时，会取消运行中的任务并等待清理；第一版不支持 detach/reattach，也不把运行转入后台；
- 第一次 Ctrl+C 写入取消请求并进入 `finalizing`，提示用户等待 runtime 停止和 workspace 清理；
- 收尾期间第二次 Ctrl+C 可以强制退出，必须尽力写入 `interrupted` 事实，剩余状态由下次启动恢复；
- 终端窗口或进程被外部终止时不宣称取消或成功，下次打开实验执行 crash recovery；
- 真正的后台运行与重新附着只在出现明确需求后设计。

## 5. 运行时示例

```text
 reprise compare                                      00:18:42
 Task: 重新设计插件架构                     Run 1/2 · Claude Code
 Candidate: new-model-alias                  Stage: running

 ── Activity ───────────────────────────────────────────────────

  Target · Claude Code
  Edited src/runtime/plugin.ts
  Ran pnpm test · failed

  Controller
  Inspecting the latest failure and original user expectations...
  Read target transcript · latest 2 turns
  Read original session · turns 14–17

  Controller decision · CORRECT
  The adapter signature is incompatible.

  Input to Claude Code
  ┌─────────────────────────────────────────────────────────────┐
  │ 请检查 adapter 的共享调用方，修复接口后重新运行相关测试。 │
  └─────────────────────────────────────────────────────────────┘

  Delivered · accepted · target turn 6

 ───────────────────────────────────────────────────────────────
  Details   Target Runtime   Diff   Metrics   Stop
  target 42k tok · controller 6k tok · 7 target tool calls
```

宽终端可以使用双栏，窄终端切换独立页面；“右侧入口”不是架构约束。当前 MVP 使用固定候选配置，主时间线一次只聚焦该候选；候选切换不在 TUI 中提供。页脚只列出该页确实会响应的键，清单见[页脚快捷键](#10-页脚快捷键)。

## 6. 运行结束后的三层体验

1. **Comparison 摘要**：Host 投影终止、已有硬数和报告入口；有对照时可选显示信封 `headline`。不把 Controller `done/satisfied` 理由当成对照结论。跳过对照时对照为未运行，不写两边都如何。token/cost 未采集时显示 `not recorded`。不解析 `report.html`，不给统一质量总分。
2. **本地 HTML 报告**：提供详细并排比较。第一版是一次性生成的静态本地文件，不实现完整 Web 应用或第二套控制面。
3. **原始详情**：Harness 自有的持久化 trace、decision 和可用 telemetry 可通过本地入口打开；token/cost 未采集时显示 `not recorded`。候选隔离副本留在实验目录 `environment/runs/{runId}`，结果页列出该路径，`w` 打开它；cleanup 不删除其中交付物。第一版不承诺内嵌通用 artifact 预览，专有 artifact 只保证 metadata 和安全打开入口。

## 7. 失败与中断体验

- preflight 失败时停留在准备页，说明失败条件及是否允许探索运行；
- Controller 或 Target 失败时保留此前活动流，不用一个通用 `failed` 覆盖具体结果；
- approval 需要真人决定时明确暂停并标明请求来源；
- delivery unknown 时停止继续发送，并显示不确定性；
- 用户停止时分别显示取消和清理进度，最终单独展示 cleanup 状态；
- 关闭 TUI 会取消 active run，不提供 detach；
- TUI 退出或渲染失败不能改变已持久化的 CandidateRun 事实。

## 8. MVP 实现顺序

1. 首次 Pi provider 设置和 Agent 产品选择；
2. Product Pack 的历史会话与固定 Runtime 候选配置；候选模型选择暂不在 TUI 提供；
3. preflight、单次 `[准备并开始]` 和隔离副本进度；
4. 基于持久化事件的主活动时间线；
5. Controller decision、实际输入和 delivery 的清晰边界；
6. 只读 Runtime 详情、diff、metrics 和 trace 入口；
7. Comparison 摘要和静态本地 HTML 报告。

第一版不实现：在 Harness 中配置目标 Runtime 不支持的新 provider、修改用户全局 Agent 配置、从 Runtime 详情人工接管候选、自定义 dashboard/布局/主题、任意 artifact renderer 市场，以及依赖隐藏 chain-of-thought 的协议。

## 9. 验收条件

- 用户能区分内部 Agent 模型与 Runtime 候选模型；
- 当前 TUI 明确展示固定候选配置；不声称提供候选模型选择；
- 从选择 Agent 产品到启动比较只有一条明确主路径；
- Harness、Controller 和 Target 的活动来源始终可辨认；
- Controller 可见过程可以检查，但只有独立标记的输入会发送给 Target；
- 每次发送都展示协议确认的 delivery 状态；
- 主界面不被完整工具输出淹没，已持久化详情仍可到达；
- Runtime 详情第一版只读；
- 摘要同时保留 Agent 观察和固定客观事实；
- 窄终端不依赖右侧面板也能完成相同操作。

## 10. 页脚快捷键

页脚是该页会响应的键的清单，不展示没有可见效果的操作。未在文本框里编辑时，`?` 打开本页按键说明；`Ctrl+C` 在候选/恢复运行页请求取消，在其余页退出 TUI。

| 页面 | 页脚键 | 作用 |
|---|---|---|
| 封面 | Enter | 继续最近一次实验（若有） |
| 封面 | r / i | 开始运行 / 导入会话 |
| 封面（输入 `/`） | Tab / Enter / Esc | 补全命令 / 提交 / 清空 |
| 配置 | ↑↓ / Enter | 选字段 / 编辑或切换 |
| 配置 | t / s / Esc | 测连接 / 保存到本机 / 回封面 |
| 会话（产品） | ↑↓ / Enter / Esc | 选择 / 打开产品 / 回封面 |
| 会话（项目） | ↑↓ Enter `/` f m r Esc | 选择、打开、搜索、只看可跑、更多、刷新、回封面 |
| 会话（会话） | ↑↓ Enter `/` m r Backspace Esc | 选择、核对、搜索、更多、刷新、回项目、返回 |
| 会话（搜索中） | Esc / ↑↓ / Enter | 退出搜索 / 选择 / 打开 |
| 核对 | Enter / d / t / Esc | 冻结 / 展开结局 / 切换模型正文 / 回会话 |
| 历史 | Tab / ↑↓ / Enter / Esc | 运行与用例 / 选择 / 打开 / 回封面 |
| 历史详情（用例） | Enter / t / Esc | 使用该用例 / 打开路径 / 返回 |
| 历史详情（实验） | o / t / Esc | 打开报告（若有）/ 打开路径 / 返回 |
| 源目录 | Enter / Backspace / Esc | 开始隔离运行 / 改路径 / 回封面 |
| 预检 | b / Esc | 改源目录 / 回封面 |
| 候选产品 | ↑↓ / Enter / b / Esc | 选择 / 进模型 / 返回 / 回封面 |
| 候选模型 | ↑↓ / Enter / b / Esc | 选择 / 确认 / 改产品 / 回封面 |
| 确认 | Enter / b / Esc | 开跑（被挡时仍按 Enter 只提示） / 改模型 / 回封面 |
| 对照门 | Enter / s / Ctrl+C | 写对照 / 跳过 / 退出 |
| 运行（含恢复） | Ctrl+C / ? | 请求取消 / 按键说明 |
| 结果 | o / t / w / Enter / b | 报告 / 记录目录 / 隔离副本 / 回封面 |
| 错误 | Enter / b / Esc | 返回 |
| 全文 overlay | Esc | 关闭 |
| 角色 overlay | Ctrl+G / Esc | 开关 / 关闭 |

运行页是只读观看面：不向目标 Runtime 打字，续问由对照自动发。页脚不列出选择、过滤、查找、展开命令或切栏；双栏由布局自己滚动，那些键没有可靠的可见效果。

## 11. 借鉴边界

本设计借鉴 Claude Code 和 Codex 的渐进披露：主时间线展示可见 Agent 内容、工具活动、进度、权限和错误，完整 transcript、diff、状态与原始输出按需打开。借鉴的是信息取舍，不复制其视觉外观、私有事件格式或隐藏推理机制。

- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands)
