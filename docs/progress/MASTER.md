# Project Progress Master

## PPT 全流程修复（2026-09-06）

- 目标：完整实施 [失败修复规划](../plan/ppt-flow-failure-remediation-2026-09-06.md) 与 [后续实施规划](../plan/ppt-flow-next-steps-2026-09-06.md)。
- 当前：后续规划阶段一至四离线完成；阶段五已执行一次授权复跑并停在 Recovery `transient_upstream`；探测瞬时 `stopReason` 已加同预算有界重试；阶段六无 PPTX 可验。
- 完成条件：规划所有验收项有对应证据，`npm run check` 通过，受控真实复跑完成。不能以阶段性通过代替完整验收。
- 验证：最新 `npm run check` 为 17/17 通过，耗时 71.3 秒；652 项测试通过、0 失败、4 跳过，48 帧审计无尺寸问题。包含实验关闭等待终态及恢复清理失败保留引用的回归。
- 边界：真实计费复跑在本地门禁通过后确认；不提交或推送。

### 本地证据与剩余验收

- Controller：真实 ControllerAgent + 假 Runtime 覆盖 merge 空数组反馈后 replace 清账；仅一个候选输入，读取绑定当前请求，artifact 正文和反馈快照可重建。工具回调按工具名分发，避免把 ls 结果送入 read 证据回调。持续 satisfied 且只读 INDEX 时两次纠错后 Harness 终止；blocked、no_further_value、requires_real_user_decision 保持 incomplete。损坏账本拒绝回归通过。
- Pi：假 provider 配合真实 Agent 验证工具执行后瞬时失败恢复不重复副作用、最多三次尝试、认证不重试、退避取消、巨型首输入拒绝；首个长工具回合可摘要 prefix，摘要失败明确诊断，取消保持 AbortError。请求前压缩与 overflow 恢复均跨后续 append 保留 summary + tail，6 项 session 可靠性测试通过。
- TUI：结果/历史区分候选终止、task 和 Comparison，旧成功报告保留；公开键盘回归覆盖历史/结果 Esc，共享 delivery 事件推进生成阶段；两 Pack 发现摘要跳过注入指令。相关 fixtures 和提示词/工具快照已同步。
- Controller 补充验收：纠错时间预算先于次数耗尽、opening 理解失败/取消不投递候选且 cleanup complete；shell 正文 artifact 可重放且不能单独满足 workspace_read 完成门；必需 ledger 缺失或损坏均拒绝。投影写入失败后保留权威 ledger，显式 merge 空增量可幂等重建，尚未接入独立 crash-resume 自动重建。
- Pi 补充验收：schema repair 共用原 deadline；固定系统/工具输入扣除输出预留；不可缩减 overflow 明确失败。Harness 工厂与 manifest 共用实际 AgentBudget，默认调用有 24 小时定时器，生产 TUI 支持显式候选 policy 和分开的 Recovery 调用预算。工厂超时测试确认挂起请求收到 abort。
- TUI 补充验收：探针、Recovery、Controller opening/后续判断区分阶段和可重试性；通用标题为“无法继续”。项目 catalog 名称和会话 cwd 来源在 60/120 列回归可见，登记路径作为无 cwd 时的 fallback；快照已重新生成。
- 取消与预算新增证据：RecoveryAgentPort 暴露实际 timeoutMs，context 与恢复输入 artifact 采用同值；假配置 43,210 毫秒在调用及持久化材料中一致。Host 取消不依赖 provider 主动返回，合并的 signal 同时中止 append 等待与工具；回归修复前在 1 秒时超时，修复后返回 cancelled，晚到 send 不生效。
- Recovery 的 signal 经生产 workflow、连接探测、Host 和 readiness/候选重执行传递；阶段边界取消阻止继续验收旧 completed 信封。真实 RecoveryAgent + 假 provider 回归证明挂起模型取消后落盘 cancelled、discard staging 一次、无 accept、来源文件不变。公开 Ctrl+C 回归返回封面且不进入候选选择；关闭 TUI 会 abort 并等待 recoveryFinished。
- Comparison 取消：实验 handle.cancel 将 signal 传到 Planner/Reporter 的 Host 与工具。挂起任一阶段都能取消并落盘 comparison.json cancelled，Planner 取消不启动 Reporter，候选已有 outcome 不变。既有 Planner 失败仍允许独立 Reporter，取消单独处理。
- preflight 取消：公开 Ctrl+C 在 preflight 返回后阻止 Recovery 启动；文件系统已开始的检查仍等待返回。关闭 TUI 的直接回归证明会 abort 恢复并等待其 cleanup Promise，不能以停止渲染代替清理完成。
- 关闭清理：TUI closing 等待 activeExperiment.result 并检查 cleanup，所有并行清理结算后再尝试丢弃 cached staging；失败返回本地化错误。discardRecovery 失败保留引用，返回封面也会展示错误。Recovery 失败清理残留时返回 cleanupFailed/staging，原始落盘仍由 recovery.cleanup_failed 事件证明；取消提示不能覆盖清理失败。
- 受控驱动首轮改造：本地 drive.mjs 使用 REPRISE_RUN_PPT_FLOW=1 opt-in、独立 rerun 目录、45 分钟总计时、16 个候选输入/24 次 Controller 调用，以及 5 分钟内部请求/10 分钟 Recovery 请求上限。删除自动重新 /run 和 resume/tail 分支、恒真等待、backToHome 绕过；Ctrl+G 打开 actors 并断言，结果要求 completed Comparison。finally 关闭并等待清理。语法检查通过，默认入口子进程以 exit 1 拒绝启动且没有实验活动。
- 驱动止损与关闭补强：总预算改为固定单调 deadline，预算检查不依赖定时器回调；产品、项目、模型游标移动改为有限步且验证每步进展；等待、截图和 delay 接入 AbortSignal，截图错误脱敏。新增 `docs/.local/2026-09-06-ppt-flow/drive-budget.test.mjs` 离线回归，覆盖定时器延迟、游标停滞、截图取消及 probe/Recovery/candidate/Comparison 四阶段预算触达后的零新增请求与清理等待。
- TUI 启动取消补强：候选启动拥有独立 startup signal，Ctrl+C/返回/关闭均能中止；verify/Recovery accept 返回后检查取消，Harness 探测接收同一 signal。迟到 Recovery 结果统一经过 staging 丢弃，清理失败保留引用并拒绝 closing；新增启动中取消和迟到清理失败回归。
- 仍需核对预算全链：驱动计时器发 Ctrl+C，但 preflight/候选 startup 等 handle 建立前的关闭等待仍有缺口；同步键盘游标循环和截图子进程也需验证总预算可中断，不能把驱动初步计时当成完整 deadline 验收。超时取消与清理需脱敏离线驱动测试，不能直接靠真实付费复跑。局部 cleanupFailed 展示及闭环需进一步检查。
- 本轮门禁稳定性风险：首轮 Claude admission 在 2 秒窗口内未获 replay，单项复测通过；第二轮多个冻结及 TUI 审计遇到 copyAtomic rename EBUSY。流式/原生复制各 80 次独立诊断均未复现，未修改公共文件 helper。最后完整门禁通过，但 Windows 临时文件锁原因尚未证实；失败输出与最终输出分别保留在本地测试目录。
- 后续规划离线补强：受控驱动 opt-in 与阶段日志进入 `scripts/`；四阶段超时后零新增请求与 cleanup 等待进入 `test/ppt-flow-budget.test.ts`。确认页在 startup 已建立时 Ctrl+C 取消校验而不关闭 TUI；workflow/Recovery/closing 拒绝有观察者。Comparison 简报相对路径与历史页 stalled/failed 分列进入 `test/ppt-flow-semantics.test.ts`。预算停止后的 experiment/staging/进程判定进入 `scripts/ppt-flow-residual.ts`；PPTX 验收进入 `scripts/ppt-flow-accept.ts`；实验层分列证据进入 `scripts/ppt-flow-evidence.ts`，驱动写 `flow-evidence.json`。
- 驱动与端到端：2026-09-07 一次 `REPRISE_RUN_PPT_FLOW=1` 复跑在 Recovery 连接探测失败（`transient_upstream`，约 11 秒，`requestCount=0`），exit 1，cleanup 完成且残留可判定；未进入候选/Comparison，无 PPTX。证据在 `docs/.local/2026-09-06-ppt-flow/rerun-1788758553977-e504ae3c/`。按规划不自动第二次收费运行。
- 原始门禁输出保留在本地测试目录。首个长工具回合压缩的反向用例在修复前返回 undefined、修复后通过；工具回调的反向用例在修复前交叉触发 read/ls、修复后只触发对应工具。计划状态不能按局部回归标成完成。
- 本轮验证：`npm run check` 17/17 通过；定向 PPT 后续规划测试 23 项通过。覆盖率 lines 89.22%、branches 79.76%、functions 88.21%。未进行真实 Runtime 收费复跑。

以下保留前一项目阶段的验收记录。

## Current Objective

- Current goal: 实施 [`产品优先的会话 Intake 开发计划`](../plan/product-first-session-intake.md)。
- Non-goals: 双语 i18n、决策分类子目录、per-file 100% 覆盖率、真实计费 smoke 进 CI、dependabot 的 TypeScript 大版本升级。

## Current Phase

- Phase: 产品优先 Intake / 会话发现与产品中立 TUI 已完成审计。
- Entry condition: Comparison HTML 报告改造的结果页结构已稳定；仅允许最小产品标签参数化。
- Completion condition: 产品选择、会话隔离、身份传递、文档和 TUI 审计均通过 `npm run check`。

## Completed

- [x] Comparison Agent 自由 HTML 报告优化：接受 System Prompt 行为契约；Agent 原样写入 `report.html`，Host 投影 `reportFacts`，Comparison 失败写独立降级页，删除 Markdown renderer 主路径。
- [x] 产品优先 Intake（首批）：静态 Pack 产品页、按 Pack 惰性发现与进程内缓存、隔离项目/搜索/错误、按 `productId` freeze 和 Runtime 解析，以及 Claude Code TUI 审计帧。
- [x] 会话摘要正确性：严格校验 ISO 时间；Claude 从所有事件取最早有效时间，首条元事件缺时间不再显示 epoch。
- [x] Claude 轻量发现：列表扫描不再调用完整 import，不保留 transcript、raw JSONL 或历史事件。
- [x] 产品显示首批迁移：顶栏、确认页、运行页和结果 Runtime 失败来源使用已选产品；无产品时显示 `Agent unset` / `Unknown agent`，不回退为 Codex。
- [x] 项目/root 隔离首批：legacy 单 root 仅归属一个 Pack；同 cwd 跨产品不混组，未知 cwd 不假合并。
- [x] Session discovery page：Pack port 返回分页 items、cursor、扫描/跳过诊断；cursor 绑定产品 root，TUI 以 root 缓存并支持加载更多、刷新和取消。
- [x] 全局会话时间分页：摘要 index 先以 8 并发完成轻量读取，再按 `updatedAt + sourcePath` 全局排序；cursor v2、index diagnostics 和最多 4 个 product/root/fingerprint 内存 index 保证连续页不重读 JSONL，`r` 强制重建。
- [x] 任务 1：audit lane 改到 `windows-latest`
- [x] 任务 3：`gen-docs` 正则转义，生成区非空
- [x] 任务 4：分析器接进 `check` / `audit`，修 60 列溢出
- [x] 任务 2：`DISPLAY_CWD` 改为 `C:\reprise`，重生成帧
- [x] 任务 5：`verify:docs` / `gen-docs` / 帧比对接入反向自检
- [x] 任务 6：打开 knip `exports`，删无用导出与死代码
- [x] 任务 7：抽出 TUI 审计共享实现，knip / jscpd 改为阻塞
- [x] 任务 8：门禁契约进 `engineering-gates.md`，已完成计划移出 `plan/`

## In Progress

- Current task: 产品优先 Session Intake 已完成；2026-08-16 已完成本机 Windows 11 默认根只读验收，并自动验证临时 directory junction/symlink 循环和 ACL 拒绝不会被跟随或吞掉；1,500 文件树回归作为当前 Windows 基准。TUI 会话/项目的相对时间也已接入可注入渲染时钟，帧审计不再随着真实日期漂移。完成审计另补强了快速产品切换时晚到 discovery 结果不会覆盖当前选择、以及 `excludeRoots` 不误伤相邻路径的直接回归用例。
- Owner / agent: Codex
- Related files: `src/products/contract.ts`、两个 Pack 的 `sessions.ts`、`src/products/shared/session-files.ts`、`src/tui/controller.ts`、`src/tui/view-projection.ts`、`src/tui/pages/intake.ts`、`scripts/tui-visual-audit.mjs`、产品/决策文档。

## Blocked

- Blocker: 无

## Decisions

| Date | Decision | Reason | Impact |
|---|---|---|---|
| 2026-08-15 | Comparison Agent 直接创作 `report.html` | 报告表达由同一个证据调查者负责；Host 只校验薄交付协议 | 删除 Markdown renderer 与固定成功模板 |
| 2026-08-15 | 帧基线只在 Windows 比对 | 平台相关产物，逐项注入会铺开 | audit lane |
| 2026-08-15 | 生成区输出信封字段表 | `EventEnvelope.type` 不是判别联合 | gen-docs |
| 2026-08-15 | 门禁必须附反向用例 | 干净树上退出 0 不能证明门禁在验 | 全部门禁 |
| 2026-08-14 | 覆盖率阈值取实测值，只升不降 | 避免人为缓冲允许倒退 | `test:coverage` |

## Next Actions

- 运营性复查（非实现门禁）：在真实 Windows 11 的 Claude Code 与 Codex 历史目录上按需确认产品切换不会交叉显示会话；ACL 和 junction/symlink 循环均已由隔离临时 fixture 覆盖，不创建或修改用户历史根中的 ACL 或链接。
- 如真实环境出现差异，先复用 discovery diagnostics 与 Pack root 配置定位；不要以 TUI 产品名或时间显示特判掩盖数据问题。无待开发项。

## Verification Evidence

| Time | Method | Command / evidence | Result |
|---|---|---|---|
| 2026-08-15 | Comparison HTML gate | `npm run check` | 11 通过, 0 失败；272 tests（271 pass，1 skipped） |
| 2026-08-15 | local check DAG | `node scripts/run-gates.mjs check` | 11 通过, 0 失败；含 tui analyze、knip、jscpd |
| 2026-08-15 | TUI visual audit | `npm run audit:tui:check` | 43 frames, 0 issues；含产品页和 Claude Code 项目/会话页 |
| 2026-08-15 | knip exports | `npm run knip` | exit 0 |
| 2026-08-15 | jscpd | `npm run jscpd` | 9 clones, 0.62%, threshold 1 |
| 2026-08-15 | Intake targeted tests | `node --test product-first-intake, cli, codex-intake, intake-ui` | 27/27 passed |
| 2026-08-15 | Intake full gate | `npm run check` | 11 通过, 0 失败；275 tests（274 pass，1 skipped） |
| 2026-08-16 | 全局 summary index 回归与全门禁 | `npm run build`；41 个受影响测试；`npm run check` | 41/41 passed；11 通过, 0 失败, 0 跳过；297 tests（296 pass，1 skipped）。 |
| 2026-08-16 | junction 回归与最终门禁 | `npm run build`；42 个受影响测试；`npm run verify:docs`；`npm run check` | 42/42 passed；文档检查通过；11 gates 通过，298 tests（297 passed，1 skipped）。 |
| 2026-08-15 | Intake targeted build/test | `npm run build`；`node --test dist/test/widgets.test.js dist/test/product-first-intake.test.js dist/test/intake-ui.test.js dist/test/claude-code-pack.test.js dist/test/codex-intake.test.js` | build 通过；98/98 passed。覆盖 Claude/Codex 摘要、root/project 隔离和产品中立 TUI fallback。 |
| 2026-08-15 | 产品中立 TUI 全门禁 | `npm run audit:tui:check`；`npm run check` | 43 frames, 0 issues；11 gates 通过，281 passed、1 skipped。 |
| 2026-08-15 | 流式摘要 targeted | `npm run build`；`node --test dist/test/session-discovery-page.test.js dist/test/session-summary-streaming.test.js dist/test/claude-code-pack.test.js dist/test/codex-pack.test.js` | build 通过；58/58 passed；覆盖 1,500 文件树、未知时间排序、file-mtime fallback、格式错误及超限。 |
| 2026-08-15 | 产品优先 Session Intake 最终门禁 | `npm run check` | 11 gates 通过，287 tests（286 passed，1 skipped）；含 typecheck、lint、TUI frames/analyze、generated docs、knip、jscpd。 |
| 2026-08-16 | 会话页渲染时钟、扫描回归与最终门禁 | `node --test dist/test/session-summary-streaming.test.js dist/test/session-discovery-page.test.js dist/test/product-first-intake.test.js dist/test/codex-intake.test.js dist/test/intake-ui.test.js`；`npm run audit:tui:check`；`npm run check` | 44/44 通过；43 frames、0 issues；11 gates 通过，301 tests（300 passed，1 skipped）。相对时间帧由固定注入时钟验证，不重写基线。 |`r`n| 2026-08-16 | 完成审计补强与最终门禁 | `npm run build`；`node --test dist/test/paths.test.js dist/test/product-first-intake.test.js dist/test/codex-intake.test.js dist/test/session-discovery-page.test.js dist/test/session-summary-streaming.test.js dist/test/intake-ui.test.js dist/test/widgets.test.js dist/test/claude-code-pack.test.js`；`npm run verify:docs`；`npm run check` | 121/121 通过；文档检查通过；11 gates 通过，302 tests（301 passed，1 skipped）。直接覆盖晚到 discovery 结果隔离与相邻 `excludeRoots` 路径边界。 |

## Drift / Risks

- Plan drift: dependabot 积压（含 TypeScript 7）不在本轮落地
- New dependencies: 无
- New risks: 工作区包含 Comparison/TUI 审计等并行未提交变更；result 页只能继续最小参数化，不能扩展到报告逻辑。双 Pack 结构性重复仍占 jscpd 条数；阈值只升不降。
- Replan needed: 否；剩余真实历史人工验收不改变端口或 on-disk 格式。
