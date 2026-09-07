# PPT 全流程后续实施规划

## 目标

把本地离线修复推进到一次可审计的真实 PPT 流程验收。最终结果必须能区分候选任务结果、Comparison 结果、Recovery 限制和清理状态；任何一项失败都不能被另一项的成功覆盖。

本规划承接 [PPT 测试失败分析与修改规划](./ppt-flow-failure-remediation-2026-09-06.md)。当前代码已完成有限观察分页、Controller 纠错、Pi 请求恢复、TUI 取消和本地驱动止损的主要修复。下一阶段重点是验证剩余边界和完成一次受控真实复跑，不重新设计已有架构。

## 当前基线

- 阶段一至阶段三的离线完成条件已有版本化回归；阶段四离线准入已记录。
- 阶段五已执行一次授权复跑，停在 Recovery 连接探测 `transient_upstream`，未进入候选。
- 尚未产生可验收的候选 PPTX。

## 阶段一：收紧本地复跑入口

**状态：已改完（离线）。**

先把 `docs/.local/2026-09-06-ppt-flow/drive.mjs` 作为唯一受控驱动使用。

1. 固定独立输出目录、总 deadline、候选轮数、Controller 调用数、Recovery 调用时间和 Comparison 调用时间。
2. 启动前检查 `REPRISE_RUN_PPT_FLOW=1`；未显式设置时不得创建实验或发起模型请求。
3. 删除自动重跑、旧实验续跑和绕过公开键盘路径的分支。
4. 每个阶段记录开始时间、结束时间、请求计数、终止原因和清理结果；日志只保留脱敏信息。
5. 运行一次短预算假 workflow 回归，确认探测、Recovery、候选、Comparison 任一阶段超时后都不再新增模型请求，并等待资源清理完成。

完成条件：驱动默认拒绝启动；四阶段预算回归通过；预算耗尽后实验目录、staging 和进程状态均可判定。

证据：`scripts/ppt-flow-driver-guard.ts`、`scripts/ppt-flow-phase-journal.ts`、`scripts/ppt-flow-residual.ts`、`test/ppt-flow-driver-guard.test.ts`、`test/ppt-flow-budget.test.ts`、`test/ppt-flow-accept.test.ts`；本地 `drive.mjs` 在未设置 `REPRISE_RUN_PPT_FLOW=1` 时子进程 exit 1，结束时写 `residual.json`。

## 阶段二：核对 TUI 异步生命周期

**状态：已改完（离线）。**

围绕 `src/tui/controller-run.ts`、`src/tui/intake-tui-nav.ts` 和 `src/application/tui-workflow.ts` 做状态边界复核。

1. 在 preflight、Recovery、候选校验、Recovery `accept`、Harness opening 和实验句柄返回前分别触发取消。
2. 断言取消后不会进入下一阶段，不会发送新的候选输入，也不会利用旧的 completed Recovery 结果。
3. 句柄迟到时取消句柄并等待 `result`；结果中的 cleanup 不完整时，`closing` 必须失败并保留诊断。
4. Recovery 返回 staging 后发生关闭或清理失败时，保留资源引用和可重试入口。
5. 比较门闩、workflow Promise 和 closing Promise 均必须有观察者，不产生 `unhandledRejection`。

完成条件：每个 await 边界都有离线反例；取消、失败和正常完成三类路径的页面、事件和 cleanup 状态一致。

证据：`test/tui-workflow.test.ts` 覆盖 preflight/Recovery/accept/opening/迟到句柄/cleanupFailed；`test/ppt-flow-lifecycle.test.ts` 覆盖确认页候选校验取消、目录校验过期、以及 workflow/Recovery/closing 拒绝无 `unhandledRejection`。确认页在 `startupAbort` 已建立时 Ctrl+C 走取消而非关闭。

## 阶段三：核对 Comparison 输入与结果语义

**状态：已改完（离线）。**

1. 用合成的 5 MB 单条事件、混合多字节文本和转义 JSON 验证最终模型文本块始终低于字节上限。
2. 验证首条超大记录可按 UTF-16 偏移续读，游标持续前进，不能重复返回或死循环。
3. 验证 Planner 和 Reporter 使用同一份 `briefing/` 索引；索引中所有路径都相对 attempt 根且可被 workspace 工具读取。
4. 验证读取绑定当前 `requestId`、`runId`、路径和内容摘要；旧请求、其他 run 和导航索引不能满足当前完成门。
5. 让候选 `stalled` 与 Comparison `failed` 同时存在，确认结果页和历史页分别展示两种状态，并保留旧成功报告。

完成条件：离线输入不再触发 `context_length_exceeded`；失败报告被明确标记为诊断产物；有效结果与失败原因可从事件日志复原。

证据：`test/agent-tools.test.ts` 的 5.1 MB / UTF-16 续读；`test/codex-experiment-support.ts` 与 `test/ppt-flow-semantics.test.ts` 的 `briefing/` 相对路径；`test/codex-experiment.test.ts` 与 `test/agent-host.test.ts` 的 requestId/runId/INDEX 完成门；结果页与历史页同时展示 `stalled` 与 Comparison `failed`/`Diagnostic`。

## 阶段四：真实复跑前的准入检查

**状态：已改完（离线准入）。** 未设置 `REPRISE_RUN_PPT_FLOW=1`，按本阶段规则停止，不发起收费请求。

真实运行前必须逐项确认：

- `npm run build`、相关定向测试、`npm run check` 通过（17/17）。`npm run test:coverage` 阈值满足（lines 89.22%、branches 79.76%、functions 88.21%）；同一次覆盖率跑中有 2 个既有用例偶发失败（Claude spawn UNKNOWN、Recovery 生命周期），单独复测均通过。
- 驱动使用独立 `rerun-*` 目录，不覆盖原始失败证据。
- 预算已记录：总 45 分钟、候选 16 轮 / Controller 24 次、内部请求 5 分钟、Recovery 请求 10 分钟。
- 驱动日志脱敏；配置页截图检查明文密钥。
- 目标源会话 needle 为 `20260825ppt`，历史 cwd 为 `C:\yanjiusheng\本子与项目撰写\CNCERT项目-漏洞整理\20260825ppt`。
- 真实运行只允许一次；驱动失败后写证据并退出。

如果准入条件不满足，停止在离线回归阶段，不启动收费请求。

## 阶段五：单次受控真实复跑

**状态：已执行一次授权复跑（2026-09-07）。** 停在 Recovery 连接探测，未进入候选。按「只允许一次」停止，不自动复跑。全流程未通过。探测对瞬时 `stopReason` 的有界重试见 [Harness 连接探测决策](../decisions/accepted/2026-09-07-harness-probe-transient-retry.md)；再次全流程需要新的授权。

沿原测试路径执行：Codex 历史会话 → 冻结和 Recovery → Claude Code catalog `default` → 隔离候选 → Comparison → 历史查看。

运行期间逐项记录：

1. Recovery：`failed`。错误页 `Harness 连接探测: 暂时失败；服务恢复后可重试。 (transient_upstream)`。阶段约 11 秒，`requestCount=0`，无 staging、无 experiment 根。不归因于候选质量。
2. 候选：未开始。无解析模型、轮数、Controller 决策或终止类型。
3. Comparison：未开始。无阶段、错误类别或输入预算。
4. 公开键盘：封面、配置、历史 Esc、`/intake` 搜索 `20260825ppt`、核对页均走键盘。错误页提示 Enter/b 返回；驱动在探测失败后退出，未截结果后封面或历史。
5. cleanup：驱动 `close` 等待完成（`cleanup-complete`）。`residual.json`：`experimentRootExists=false`，`stagingExists=false`，`cleanup=never_started`，`processAlive=false`，`determinable=true`。未启动第二次实验。

证据：`docs/.local/2026-09-06-ppt-flow/rerun-1788758553977-e504ae3c/`（`journal.jsonl`、`phases.json`、`residual.json`、`frames/17-recovery-error.txt`）；过程记录 `authorized-run-2026-09-07.md`。退出码 1。配置帧密钥为圆点遮罩。会话 `01a038f9-f4c5-7710-bfdc-c5076fd42d8e`，列表标 partial。

## 阶段六：PPT 交付物人工验收

**状态：未开始真实文件验收。** 检查器已落地：`scripts/ppt-flow-accept.ts`、`scripts/ppt-flow-evidence.ts`。OOXML 可判定能否打开、可编辑文本、纯截图、白底、形状是否越出幻灯片，以及与 HTML 页数/标题是否一致。驱动收集证据时对候选 PPTX 调用 `readOfficePptIssues`（officecli `view issues --json`）；工具缺失或拒绝包时回退 OOXML，结果可为 pass / incomplete / fail。阶段五产生候选 PPTX 之前，不能把交付物标为达标。

只有候选生成文件后，才检查内容质量：

- PPTX 能被 PowerPoint 或等价解析器打开。
- 页面包含可编辑文本、形状或图表对象，而不是单张截图。
- 页面背景、卡片和标题符合白底要求。
- 三页均无文字、表格或图形溢出。
- 数据来源和计算口径能对应到项目文件或事件证据。
- HTML、PPT 和 PPTX 的页数、标题和关键数字一致。

Controller 的自述、文件扩展名或文件存在本身都不能替代这些检查。无法验证时，结果标记为证据不足或 incomplete。

## 失败处理

按失败层分别记录：

- 上游连接或认证失败：保留探测阶段和可重试性，不归因于候选质量。
- Recovery 失败：保留来源不变、staging 状态和清理结果，不进入候选。
- Controller 未收敛：保留 ledger、拒绝反馈和 Harness 终止原因，不增加候选续做请求。
- Comparison 超限或协议失败：保留候选结果，单独生成诊断，不伪造完成报告。
- PPT 内容未达标：判为 incomplete，并列出可复核的页面或数据证据。

## 交付顺序

1. 完成本地驱动和生命周期离线回归。
2. 完成 Comparison 输入、证据归属和结果语义回归。
3. 更新必要的 ADR、进度入口和测试快照。
4. 重新运行构建、门禁、覆盖率和文档验证。
5. 2026-09-07 已获得一次授权并执行受控复跑；停在 Recovery 探测失败。再次全流程需要新的授权。
6. 本次已保存脱敏过程记录、终止原因和清理状态。PPT 内容检查因无候选文件而未做。

在第 5 步之前，不得声称真实全流程已经通过；在第 6 步之前，不得声称 PPT 交付物质量已经达标。
