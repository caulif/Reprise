# Reprise 重构进度

## 当前目标

实施[架构重构规划](../plan/reprise-architecture-redesign.md)，具体步骤见[重构实施计划](../plan/reprise-refactoring-execution.md)。唯一批次顺序与 A1–A18 在总计划维护，交互验收在[TUI 规划](../plan/reprise-tui-design.md)维护，本文件不复制设计决定。

## 当前批次

按[重构后续审查清单](../plan/post-refactor-architecture-audit.md)收口 Comparison 双轨读取、Runtime Journal 归属、终态查询投影与规划文档术语。

## 验证记录

2026-09-10 二次审查：Comparison 从 attempt 根按 INDEX 挂载读取双轨材料；Runtime Journal 校验 turn/message/call 与 session 生命周期；终态由 `candidateRunDisplayFromEvents` 投影，TUI 不再解析时间线 `State:`；规划文档 `projection` 与 `runtime` 并列。ADR：[Journal 归属](../decisions/accepted/2026-09-10-runtime-journal-affiliation.md)、[阶段查询](../decisions/accepted/2026-09-10-candidate-run-phase-query.md)。`audit-root/` 与 `unused/` 已在 `.gitignore`。`npm run check` 17 门禁通过（847 pass / 4 skip）。

2026-09-10 审查清单：Controller briefing 原子发布；Comparison `SNAPSHOT.txt` 与失败不覆盖成功 `report.html`；Recovery 机械检查失败不得沿用未通过信封；TUI 阶段走 `candidateRunPhaseFromEvent`；共享 JSONL peek 由 Pack 传入提取函数；LaunchContext / Runtime payload / UserVisibleTurn 写 schemaVersion 1，未知事件版本 `unsupported_schema`。ADR：[briefing 原子发布](../decisions/accepted/2026-09-10-controller-briefing-atomic-publish.md)、[封存快照](../decisions/accepted/2026-09-10-comparison-sealed-snapshot.md)、[机械检查 fail-closed](../decisions/accepted/2026-09-10-recovery-mechanical-fail-closed.md)、[阶段查询](../decisions/accepted/2026-09-10-candidate-run-phase-query.md)、[schemaVersion](../decisions/accepted/2026-09-10-persistent-schema-version.md)。`npm run check` 17 门禁通过（843 pass / 4 skip）。

2026-09-10 抽取 Claude Code 与 Codex 共享宿主（进程关闭、turn wait、可用性探测、Session listing 摘要）；`protocol`/`projection` 仍在 Pack。仓库根 `audit-root/`、`unused/` 加入 `.gitignore`。ADR：[Pack 共享宿主](../decisions/accepted/2026-09-10-pack-shared-runtime-host.md)。`npm run check` 静态/jscpd/knip/审计通过（jscpd 16 clones、0.44% duplicated tokens）；`npm run test:only` 835 pass / 4 skip。

2026-09-10 Controller 用户视图唯一入口 `current-user-view.md`；`CandidateRuntimeEvent` 为 Journal payload。ADR：[用户视图](../decisions/accepted/2026-09-10-controller-current-user-view.md)、[Journal payload](../decisions/accepted/2026-09-10-candidate-runtime-journal-payload.md)。`npm run check` 17 门禁通过（827 pass / 4 skip）。

2026-09-10 Application/候选链阶段 10 收口：TUI/CLI 除进程根外走 `application/intake-catalog` 与 `experiment-queries`；Host `discoverProductSessions` 稳定排序。ADR：[候选链模块目录](../decisions/accepted/2026-09-10-candidate-chain-module-layout.md)。`npm run check` 17 门禁通过（826 pass / 4 skip）。

2026-09-10 Application/候选链阶段 10 目标树：history `{discover,read,normalize}`、`infrastructure/process/{spawn,terminate,stdio}`、Pack `{runner,protocol}`、`controller-queries`、`recovery/input`、`test/{core,products,application,candidate,tui,cli}`。ADR：[候选链模块目录](../decisions/accepted/2026-09-10-candidate-chain-module-layout.md)。`npm run check` 17 门禁通过（825 pass / 4 skip）。

2026-09-10 Application/候选链阶段 10 拆分：`candidate-run-cleanup`/`candidate-run-facts`、`recovery/admission`、`history/{types,source-refs}`、`environment/snapshots`；`ProductPack` 必填 history/runtime/projection，去掉 `CompleteProductPack`。ADR：[候选链模块目录](../decisions/accepted/2026-09-10-candidate-chain-module-layout.md)。`npm run check` 17 门禁通过（824 pass / 4 skip）。

2026-09-10 Application/候选链阶段 L 历史端口：TUI 发现/检查/冻结与 CLI 查询导入走 `ExperimentWorkflow`；architecture 禁止 TUI/CLI 直接调用 `packHistory`/`freezeCase`/`importVerifiedSession`。`npm run check` 17 门禁通过（824 pass / 4 skip）。

2026-09-10 Application/候选链阶段 10 目录：内置 Pack 在 `src/products/packs/`；observations 在 `src/products/history/`；launch/staging/journal 文件名对齐执行指南。ADR：[候选链模块目录](../decisions/accepted/2026-09-10-candidate-chain-module-layout.md)。`npm run check` 17 门禁通过（824 pass / 4 skip）。

2026-09-10 Application/候选链阶段 10：删除 `TargetActivity`/`runtime.public_activity`/`UserSurfaceProjection.translate`；TUI 正式时间线读 `candidate.user_view_persisted`。ADR：[UserVisibleTurn 时间线](../decisions/accepted/2026-09-10-user-visible-turn-timeline.md)。


2026-09-10 Application/候选链 Journal：落盘 payload 含 `sessionId`/`evidenceRefs`，写入后按 `CandidateRuntimeEvent` 校验。`npm run check` 17 门禁通过（829 pass / 4 skip）。

2026-09-09 Application/候选链阶段 F.2：Adapter 只向 Journal 写 `runtime.<CandidateRuntimeEventType>`；Application 拒绝产品私有类型；TUI 时间线不把原始 runtime 帧当 Activity。ADR：[Runtime 事件](../decisions/accepted/2026-09-09-candidate-runtime-events.md)。`npm run check` 17 门禁通过（828 pass / 4 skip）。

2026-09-09 Application/候选链阶段 H/L：`startExperiment`/`preflightExperiment`/`recoverExperiment`；workflow 持有 Recovery 活对象；TUI 投影 `RecoveryView`。ADR：[产品无关实验入口](../decisions/accepted/2026-09-09-product-agnostic-experiment-entry.md)。`npm run check` 17 门禁通过（827 pass / 4 skip）。


2026-09-09 Application/候选链阶段 C–D：observations 含 session.json、events/{historical,run}、user-inputs 原文、省略 sourcePath；启动前写入 `candidate-launch.json`，根外 workspace 与缺 observations 不创建 CandidateRun。ADR：[观察树](../decisions/accepted/2026-09-09-observations-tree.md)、[LaunchContext](../decisions/accepted/2026-09-09-candidate-launch-context.md)。`npm run check` 17 门禁通过（820 pass / 4 skip）。真终端、付费 lane、Runtime smoke 不在本批关闭。

2026-09-09 Application/候选链阶段 B：删除 `SessionSourceAdapter`/`RuntimePort`/`TargetActivityTranslator` 与 `packSessions`/`packActivity`；Fake Pack 可发现会话、列模型、创建 Runner。`npm run check` 17 门禁通过（817 pass / 4 skip）。真终端、付费 lane、Runtime smoke 不在本批关闭。

2026-09-09 Agent 基座全面重构：Provider 无关 `AgentHost`/`AgentSession`（`work`/`request`），Pi 仅在 `providers/pi`；Fake adapter；顺序工具执行；业务 Agent 只调用 Host 公共边界。ADR：[基座 Host](../decisions/accepted/2026-09-09-agent-foundation-host.md)。规划见 [实施计划](../plan/agent-foundation-refactor-plan.md)。`npm run check` 17 门禁通过（814 pass / 4 skip）。真终端、付费 lane、Runtime smoke 不在本批关闭。

2026-09-09 Recovery Agent 模块重构：单工作副本、连续三轮 Session、`ready`/`blocked` 信封、Host 机械检查、封存起点后 `prepareRun` 复制独立副本。ADR：[单工作副本自主三轮循环](../decisions/accepted/2026-09-09-recovery-single-workspace-agent-loop.md)。实施入口见 [重构计划](../plan/recovery-agent-refactor.md)。`npm run check` 17 门禁通过（803 pass / 4 skip）。真终端、付费 lane、Runtime smoke 不在本批关闭。

2026-09-09 Comparison 与 Controller 重构收口：Comparison 四轮 + `user-inputs` 索引 + `timeoutMs: 0` + 真实 metrics；提案迁入 [可分享任务比较卡](../decisions/accepted/2026-09-09-comparison-shareable-task-card.md)。Controller 首次 `decide` 自由理解后 opening 信封，`view.txt`/`permissions.txt`/`history/user-inputs/INDEX.tsv`，后续仅 settled turn 决策。ADR：[先理解再按视图决策](../decisions/accepted/2026-09-09-controller-understand-then-view.md)。`npm run check` 17 门禁通过（806 pass / 4 skip）。

2026-09-09 Comparison 四轮委托：Host `requestFreeform`；`observations/user-inputs/INDEX.tsv`；一次 `compare()` 四轮且仅末轮信封；装配 `timeoutMs: 0`；`reportFacts.metrics` 只投影已采集 token，无生成区间不写速度。审美与真实模型比较卡不进门禁。规划见 [全面重构方案](../plan/comparison-agent-full-refactor.md)。

2026-09-08 模块所有权 O1–O7：活动身份在 experiment-activity；去掉 TUI/application 空转发；Recovery 在 `src/application/recovery/` 并按所有者拆分；experiment.ts 不再再导出 recover/preflight；TUI config/history 用窄接口；Agent 在 `infrastructure/agent/`，schema 按 ids/scene/event/recovery/task-case/run 拆分。`npm run check` 17 门禁通过（796 pass / 4 skip）；`reprise --version` / `--help` 可跑。真终端、付费 lane、Runtime smoke 不在本批关闭。

2026-09-08 TUI 界面重构 U1–U6：`npm run check` 17 门禁通过（含 `audit:tui` 48 帧 0 overflow、`verify:docs`）。封面斜杠为 `/intake` `/history` `/config` `/lang` `/help`；候选结束后结果段 `c` 对照；运行中 Esc 不取消。真终端 IME/滚轮/拖选不在本批关闭。

2026-09-08 进一步审查实施：F1 来源 `--source-product` 与候选 `--product/--model` 拆开；F2/F3 应用发布真实 activity 且前台 SIGINT 覆盖 prepare/run/compare；F4 JSON/JSONL `Value.Check`；F5 Workflow 注入 Pack lookup；F6 探测前可取消。P4 矩阵见 [平台证据](../plan/2026-09-08-platform-evidence-matrix.md)：Windows 部分 verified，macOS/Linux unverified。目标 ADR 迁入 [Session harness workflow](../decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)。未关闭：真人 IME、授权 Runtime smoke、Controller 付费 lane 与 `REPRISE_AGENT_CONTEXT_PROBE` 对拍。

2026-09-08 重构评估收口：规划见 [R1–R4](../plan/2026-09-08-refactoring-review-closeout.md)；决策见 [只读历史与 run 所有权](../decisions/accepted/2026-09-08-committed-history-and-run-ownership.md)。未关闭：真实模型 streamFn 对拍、三 OS 真终端、Controller 付费 lane。

2026-09-08 走查 fe4220：规划见 [墨水屏走查修复](../plan/2026-09-08-fe4220-run-remediation.md)；Host 抽取见 [决策](../decisions/accepted/2026-09-08-host-decision-json-extraction.md)。反向：纯散文仍 `invalid JSON`；绝对路径工具仍拒。

2026-09-08 Windows Terminal 人工窗口：版本 1.24.11911.0。最大化 40s 等待：`viewportMouse=76`、`rawStdin=76`、`viewportWheel=0`、`imeLike=0`。随后对同一版本前台窗口做 OS `SendInput` 滚轮/拖选（非 Cursor 合成、非 Unicode 冒充 IME）：`viewportWheel=2`、`viewportMouse=185`、`imeLike=0`。结论：聚焦 WT 时真实鼠标进 ConPTY；IME 组字仍需人在键盘，代理不得用 Unicode 注入冒充。Cursor 合成注入仍进不了该 ConPTY。

2026-09-08 Controller 能力 lane v3：夹具去掉 `write`/`edit`/`shell_exec`，只留 ls/read/grep/find。MiniMax-M3 报告见 TEMP `reprise-controller-eval-v3.json`：`01-complete` 匹配 done；`02-missing-artifact` send/`intent`；`11-no-progress` 与 `05-user-decision` `invalid_output`/`protocol`，`failureReason` 为 schema 根联合校验失败；`09-conflict` `agent_failure`。结论：带工具时抽不出 JSON 主要是可写工具面干扰；收成只读后 Host 能完成合法 `done`。剩余失败记为模型能力/偶发 Host 失败，不改 `CONTROLLER_SYSTEM_PROMPT`。

2026-09-08 M7 别名清理：删除 `createCodexExperimentWorkflow` / `createCodexTuiWorkflow` / `CodexTuiWorkflow`，调用方改 `createExperimentWorkflow` / `createHarnessWorkflow` / `ExperimentWorkflow`。architecture 测试禁止别名回归。

2026-09-08 Windows Terminal 探测 v10：探针在 `start` 后写 `.ready`，启动器对唯一 Cascadia 标题注入滚轮与 PageDown（`injected=hwnd=…`）。等待 2500ms 后 `rawStdin=0`、`viewportWheel=0`、`imeLike=0`。Cursor 保持前台时合成输入进不了该 ConPTY。人工关闭方式：聚焦该 Windows Terminal，设置 `REPRISE_TUI_PROBE_WAIT_MS` 后滚轮/拖选/IME。

2026-09-08 Windows Terminal 探测 v8：唯一窗口标题下找到 Cascadia hwnd，探测进程内注入后 `hostWheelOk=true`，但 `rawStdin=0`。

2026-09-08 Windows Terminal 探测 v3：在 TUI `start` 之后 `process.stdin.write` SGR 滚轮失败（`stdinWritable=false`）。输入监听在视口监听器之后，即使有 SGR 也会被 `handleViewportInput` 消费。

2026-09-08 Windows Terminal 探测 v2：同一 1.24.11911.0 窗口，`rows=30`，`getCapabilities().hyperlinks=true` 且 `fileLink` 发出 OSC 8；`setMouseReporting(false)` 写入关闭鼠标报告序列；`setLocale("zh")` 后画面含「导入历史」与「中文路径测试」；`closed=true`。

2026-09-08 Windows Terminal 探测：`REPRISE_REAL_TERMINAL=1` 在 Windows Terminal 1.24.11911.0（另装 Preview 1.25.1912.0）新窗口中 `TERM=xterm-256color`、`WT_SESSION` 存在、stdout TTY；`CodexIntakeTui.start` 后 `preview` 含 Reprise 与 `/intake|/config|/help`，随即 `close`。不是 IME/滚轮/拖选证据。入口：`npm run probe:tui-terminal -- <绝对报告.json>`。

2026-09-08 TUI 验收审计：假 TUI 帧含 CJK（`11-sessions-cjk-selected`）与宽/窄布局；`page-input`/`timeline-read`/`terminal-guard` 覆盖按键、OSC 8、异常 `stop`。本 Cursor 会话 `TERM=dumb`。macOS/Linux 真终端无记录。

2026-09-08 Controller 能力 lane v2：评估改为生产同构 `INDEX.md` + 只读 workspace 工具。MiniMax-M3 五族代表全部 `status=failed`，`failureCode=invalid_output`，`failureKind=protocol`。入口仍为 `evaluate:controller`。不能关闭 A3。

2026-09-08 Controller 能力 lane：`REPRISE_REAL_MODEL=1`，无 briefing/工具时 MiniMax-M3 五族代表：`01-complete` status=failed；`02-missing-artifact` send 但 intent 不符；`11-no-progress` 期望 done 实为 send；`05-user-decision` 期望 done 实为 send；`09-conflict` send 但 intent 不符。报告不含模型原文。

2026-09-08 A3 样例核对：五族相对 prompt 习惯条款成立——`user_satisfied`（01/10）应对充分证据与不同路径停；`needs_verification`（02/08）完成声明与摘要不足须 verify；`no_further_value`（11）无进展停；`insufficient_authority`（05）越权停；`historical_agent_untrusted`（09）工具冲突须 correct。局限：合成 briefing，不是真人历史；合同 lane 为脚本输出。能力 lane 见上行。入口：`npm run evaluate:controller -- <dataDir> <绝对报告.json>`。

2026-09-08 A1–A18 核对（证据为对应批次 ADR 与测试，非本行复述设计）：A1 `pi-agent-loop-baseline`/`session-compact`；A2 三角色连续 Session 测试；A3 opening + 上列样例记录；A4 对照单 Session；A5 Recovery 无 accept；A6 压缩/修复；A7 模型输入重建；A8 历史只读；A9 取消与清理分事实；A10 角色写权限；A11 CI `windows-latest`/`macos-latest`/`ubuntu-latest` + `platform`/`process-runner`；A12 无第二套 Host；A13 CLI 不静态加载 TUI；A14 JSON 协议；A15 跨进程 cancel；A16 `plugins.json` 第三 Pack 模拟；A17 封存指纹；A18 能力/重复身份。未关闭的是 TUI 真终端与未跑的付费 lane，不是 A11/A16 本身。

2026-09-08 M7：`npm run check` 通过。无名 `sessionsRoot` 不按 Codex 身份猜测；Harness 无账本守卫停止码；公开文档与 `reprise/pack-api`/`plugins.json` 一致。ADR：[M7 收口与未关闭验收](../decisions/accepted/2026-09-08-m7-delivery-and-acceptance-gaps.md)。工作区未提交。

2026-09-08 M6.4：`npm run check` 通过。第三 Pack 经 `plugins.json` 包入口加载；发现、导入、模拟候选、活动与 TUI 列表不注入宿主 Pack。`reprise/pack-api` 从 dist 解析。平台证据分 CI 模拟 / Windows 帧 / opt-in smoke；macOS/Linux 真终端 IME 仍缺口。ADR：[第三 Pack 与平台证据](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md)。工作区未提交。剩余：M7 旧实现删除、规范生效与交付。

2026-09-08 M6.3：`npm run check` 通过。`plugins.json` 加载本地 JS/已安装包；能力与 API major 校验；重复身份不静默替换；缺模块不挡历史。ADR：[版本化本地 Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。工作区未提交。剩余：M6.4 独立第三 Pack 与平台证明。

2026-09-08 M6.2：`npm run check` 通过。本机管道/Unix socket cancel；错误 token 与死端点不删锁、不杀 PID；旧 operationId 不取消下一操作。ADR：[跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md)。工作区未提交。剩余：M6.3 版本化本地插件边界。

2026-09-08 M6.1：`npm run check` 通过。Windows PowerShell、macOS/Linux `/bin/bash`，不读 `SHELL`；`shell: false` 与 POSIX 进程组；WSL 拒绝宿主 Windows 路径；`stop` 超时 cleanup 为 `unknown`。ADR：[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。工作区未提交。剩余：M6.2 跨终端 cancel。

2026-09-08 M5.5：`npm run build` 后 `node --test dist/test/timeline-read.test.js dist/test/page-input.test.js dist/test/widgets.test.js`；随后 `npm run check` 通过。阅读锚点、时间线查找、`v` 阅读模式、OSC 8 链接与异常退出恢复。ADR：[2026-09-08-tui-reading-search-terminal](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)。工作区未提交。剩余：M6.1 明确原生平台语义。

2026-09-08 M5.4：`npm run build` 后 `node --test dist/test/timeline.test.js dist/test/public-activity.test.js dist/test/architecture.test.js dist/test/widgets.test.js dist/test/codex-intake-commands.test.js`；随后 `npm run check` 通过。单列连续时间线；公开活动持久化；历史重开不加载 Pack。ADR：[2026-09-08-public-activity-timeline](../decisions/accepted/2026-09-08-public-activity-timeline.md)。工作区未提交。剩余：M5.5 阅读、搜索与终端交互。

2026-09-08 M5.3：`npm run build` 后 `node --test dist/test/page-input.test.js dist/test/config-editor.test.js dist/test/intake-ui.test.js dist/test/product-first-intake.test.js dist/test/widgets.test.js`；随后 `npm run check` 通过。首页斜杠入口；配置未保存离开确认；列表筛选不截获 IME；空匹配禁止确认。ADR：[2026-09-08-tui-selection-and-config-keys](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)。工作区未提交。剩余：M5.4 单实验连续时间线。

2026-09-08 M5.2：`npm run build` 后 `node --test dist/test/cli.test.js dist/test/cli-protocol.test.js dist/test/architecture.test.js dist/test/experiment-operations.test.js`；随后 `npm run check` 通过。查询子命令与 JSON/JSONL 协议；source 与 scenario 互斥；未知 ID 退出 3；密钥不进 argv。ADR：[2026-09-08-cli-query-config-protocol](../decisions/accepted/2026-09-08-cli-query-config-protocol.md)。工作区未提交。剩余：M5.3 TUI 选择与配置流程。

2026-09-08 M5.1：`npm run build` 后 `node --test dist/test/experiment-operations.test.js dist/test/cli.test.js dist/test/architecture.test.js dist/test/tui-workflow.test.js`；随后 `npm run check` 通过。完整与分步共用 prepare/run；封存前不能启动候选；CLI 子命令不静态加载 TUI。ADR：[2026-09-08-shared-experiment-operations](../decisions/accepted/2026-09-08-shared-experiment-operations.md)。工作区未提交。剩余：M5.2 CLI 查询、配置与机器协议。

2026-09-08 M4：`npm run build` 后 `node --test dist/test/comparison-agent-phases.test.js dist/test/codex-experiment.test.js dist/test/comparison-report.test.js dist/test/scene-seal.test.js dist/test/snapshots.test.js dist/test/architecture.test.js dist/test/agent-host.test.js`；随后 `npm run check` 通过。每次 attempt 一个 Comparison Session；无 Planner/Reporter 双 Session；候选结束后独立对照；失败不覆盖成功报告。ADR：[2026-09-08-comparison-single-session](../decisions/accepted/2026-09-08-comparison-single-session.md)。工作区未提交。剩余：M5.1 提取与界面无关的应用操作。

2026-09-08 M3.2：`npm run build` 后 `node --test dist/test/controller-collaboration-protocol.test.js dist/test/controller-capability-evaluation.test.js dist/test/candidate-run.test.js dist/test/codex-experiment.test.js dist/test/snapshots.test.js`；随后 `npm run check` 通过。三类事实写入 INDEX/prompt；决策先于投递；未知不重发。合同 lane 不宣称语义等价。ADR：[2026-09-08-controller-collaboration-protocol](../decisions/accepted/2026-09-08-controller-collaboration-protocol.md)。工作区未提交。剩余：M4 Comparison 单 Session 与独立执行。

2026-09-08 M3.1：`npm run build` 后 `node --test dist/test/controller-full-session-judgment.test.js dist/test/codex-experiment.test.js dist/test/controller-briefing.test.js dist/test/snapshots.test.js`；随后 `npm run check` 通过。无独立 understand；opening 与后续 decide 同一 Session；新 run 不以账本拒绝 done。ADR：[2026-09-08-controller-opening-single-session](../decisions/superseded/2026-09-08-controller-opening-single-session.md)。工作区未提交。剩余：M3.2 验证协作语义和投递边界。

2026-09-08 M2.4：`npm run build` 后 `node --test dist/test/candidate-run.test.js dist/test/store.test.js dist/test/experiment-activity.test.js dist/test/cli.test.js`；随后 `npm run check` 通过。CandidateRun 先持久化再投递；取消与晚到事件不改写终态；写锁不自动夺锁。ADR：[2026-09-08-candidate-run-activity-ownership](../decisions/accepted/2026-09-08-candidate-run-activity-ownership.md)。工作区未提交。剩余：M3.1 合并首次理解与 opening。

2026-09-08 M2.3：`npm run build` 后 `node --test dist/test/scene-seal.test.js dist/test/environment.test.js dist/test/local-history.test.js dist/test/comparison-report.test.js dist/test/experiment-inspection.test.js`；随后 `npm run check` 通过。封存场景可重复运行且不依赖活源；半成品不进列表；对照读封存快照。ADR：[2026-09-08-scene-seal-and-repeat-runs](../decisions/accepted/2026-09-08-scene-seal-and-repeat-runs.md)。工作区未提交。剩余：M2.4 CandidateRun 与活动所有权。

2026-09-08 M2.2：`npm run build` 后 `node --test dist/test/recovery-envelope.test.js dist/test/codex-experiment-recovery-effort.test.js dist/test/recovery-user-status.test.js dist/test/tui-workflow.test.js dist/test/architecture.test.js`；随后 `npm run check` 通过。Recovery 连续 Session；不足证据无 accept、不循环补造。ADR：[2026-09-08-recovery-continuous-session](../decisions/accepted/2026-09-08-recovery-continuous-session.md)。工作区未提交。剩余：M2.3 场景封存与重复运行。

2026-09-08 M2.1：`npm run build` 后 `node --test dist/test/comparison-report.test.js dist/test/experiment-inspection.test.js dist/test/controller-briefing.test.js dist/test/architecture.test.js dist/test/recovery-tools.test.js`；随后 `npm run check` 通过。角色写权限由 application 注入；路径包含走 `pathContainedBy`；写入后 `realpath`。ADR：[2026-09-08-role-side-effect-ownership](../decisions/accepted/2026-09-08-role-side-effect-ownership.md)。工作区未提交。剩余：M2.2 Recovery 连续 Session 与证据不足停止。

2026-09-08 M1.4：`npm run build` 后 `node --test dist/test/agent-model-input.test.js dist/test/agent-history-read.test.js dist/test/local-history.test.js dist/test/widgets.test.js dist/test/architecture.test.js`；随后 `npm run check` 通过。History 只读事件日志；缺正文显示固定缺口文案；未知版本失败；旧 `session_completed` 不发明输出。崩溃无 record 显示 interrupted，不读 lock。ADR：[2026-09-08-history-readonly-compat](../decisions/accepted/2026-09-08-history-readonly-compat.md)。工作区未提交。剩余：M2.1 副作用所有者与角色工具边界。

2026-09-08 M1.3：`npm run build` 后 `node --test dist/test/agent-model-input.test.js dist/test/agent-host.test.js dist/test/agent-session-lifecycle.test.js dist/test/session-compact.test.js`；随后 `npm run check` 通过。模型可见输入写入事件与 `agent_model_input` 附件，空进程可重建含修复与压缩的试卷；写失败不调用模型、模型原文写失败不报成功。ADR：[2026-09-08-model-input-reconstruction](../decisions/accepted/2026-09-08-model-input-reconstruction.md)。工作区未提交。剩余：旧日志缺正文与未知版本的只读解释待 M1.4。

2026-09-08 M1.2：`npm run build` 后 `node --test dist/test/agent-session-lifecycle.test.js dist/test/agent-host.test.js`；随后 `npm run check` 通过。Invocation 事件与 Session `close` 分离；并发拒绝；取消后晚到响应不完成。ADR：[2026-09-08-session-invocation-lifecycle](../decisions/accepted/2026-09-08-session-invocation-lifecycle.md)。工作区未提交。剩余：audit 仍以长度/digest 为主，M1.3 补全文。

2026-09-08 M1.1：`npm run build` 后 `node --test dist/test/pi-agent-loop-baseline.test.js dist/test/pi-session-reliability.test.js dist/test/session-compact.test.js`。公开 `Agent` 完成工具往返、原生块、事件顺序与取消；`AgentHarness.prompt`/`compact`/`resume` 抛出未实现。唯一事实源选择写入 [2026-09-08-session-fact-owner-and-identity](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)。工作区未提交。剩余：Host 仍把请求完成写成 `agent.session_completed`，并发与关闭语义待 M1.2。

2026-09-08 文档对齐：恢复已确认的 CLI、插件、取消、TUI 约束；收敛 prompt 与平台专题，保留当前实现到目标的迁移归宿。文档门禁的结果由本次执行日志及 PR 验证栏提供，不据此宣称代码验收通过。

## 更新约定

每个实施批次记录提交或 PR、验证命令、预期与实际结果、剩余阻塞，并链接对应验收项。没有可复现证据不标为完成；不要保存逐轮对话、工具日志或另一份任务清单。
