# PPT 全流程测试失败分析与修改规划

## 1. 目标与范围

本计划针对本地测试报告 `docs/.local/2026-09-06-ppt-flow/REPORT.md` 中的 Codex 历史会话转 Claude Code 候选实验，目标是让一次已经生成交付物的回放能够正确结束，并产出可用、可追溯的比较结果。

本次交付是修改规划，不执行代码修复、不调用真实模型。实现时以当前工作区为起点，保留其中已有修改。本计划不改变模型选择、不重写 Controller，也不新增工作流引擎或依赖。

主要分析对象：实验 `recovery-78812f48-610b-45d1-ab8e-b0cd6e75a9c6`，候选运行 `run-9f3f5d24-dc3b-4f12-85d2-ac9ace3b3935`。下文序号均指该实验的事件 `sequence`，时间采用日志 UTC。依据是落盘事件、运行记录与本次读取的源码；工作区有未提交修改，不能假设当前源码与所有早期实验使用的构建逐字一致。

## 2. 结论

**这不是一个“候选模型没做出 PPT”的单一失败，而是 Controller 收敛失真与 Comparison 上下文溢出两个独立故障，另有路径导航、恢复可靠性和 TUI 投影问题。**

| 层次 | 实际观察 | 判断 |
|---|---|---|
| Recovery | `completed` 信封内为 `partial`，保留历史起点无法逐字节证明的限制 | 恢复精度限制，不能解释后续上下文溢出 |
| Candidate | 多轮生成 HTML 和 PPTX；Controller 第 9 次判断 `satisfied` | 有交付活动，不能据最终 stalled 认定模型任务失败 |
| Controller / Host | 空待办增量无法清空旧账，Host 反复要求候选处理已完成事项，最终接受 `no_further_value` | 实验停止理由受到 Harness 自己的反馈污染 |
| Comparison Planner | `planStatus=ready` | 规划阶段成功 |
| Comparison Reporter | `400 context_length_exceeded`，`kind=protocol` | 报告生成的直接失败原因，原测试报告未明确指出 |
| TUI / 驱动 | 进入结果页，但 Esc 返回失败，另开 TUI 补截历史 | 导航验收未完整通过；不等同于实验数据丢失 |

`comparison-failure.html` 是失败诊断产物，不能作为正式比较完成的证据。`stalled` 是候选运行终止分类，不能代替 Comparison 的失败分类。也不能把 Controller 的“可编辑、已渲染”文字视为本次分析已经独立验证了 PPT 质量。

## 3. 可核查证据

### 3.1 主要产物

证据根目录为本机的 `docs/.local/2026-09-06-ppt-flow/data/experiments/recovery-78812f48-610b-45d1-ab8e-b0cd6e75a9c6/`。以下路径均相对此目录，仅作历史证据定位，不作为受控文档依赖。

- `events.jsonl`：决策、拒绝、工具返回规模和比较阶段结果。
- `runs/run-9f3f5d24-dc3b-4f12-85d2-ac9ace3b3935/record.json`：`finished`、`indeterminate`、`stalled.controller_no_further_value`、cleanup complete。
- `comparison.json`：明确记录上下文超限错误。
- `recovery.json`：partial 的具体证据限制。
- `comparison-attempts/970f1aef-691e-4a15-9c91-ba5647b5471d/briefing/INDEX.md`：路径命名与挂载冲突。

以上证据属于本地忽略目录，不随计划进入版本控制；其他 checkout 执行回归应使用脱敏合成数据，不依赖这些私人会话文件。

### 3.2 关键时间线

| sequence | 事件 | 含义 |
|---|---|---|
| 422–423 | 第 3 次决策 `satisfied`，被 `evidence_required` 拒绝 | 当次决策没有符合 Host 判据的读取 |
| 464–772 | 白底、可信代码库 HTML、PPT/PPTX、数据来源先后加入账本 | 多次 `merge` 累积未解决事项 |
| 808–810 | 第 9 次决策 `satisfied`，提交 `merge + unresolvedActions: []`；Host 仍列出 5 项待办 | 空数组没有清账，这是本次关键失配 |
| 857–858 | 第 10 次决策 `no_further_value`，再被旧待办拒绝 | Host 重复投递，而非新用户需求 |
| 925–926 | 第 11 次决策 `no_further_value`，被证据门拒绝 | 两种拒绝规则先后触发 |
| 972–973 | 第 12 次决策 `no_further_value`，诊断 `reads=0` 后放行 | 拒绝上限终止了循环，但没有恢复正确完成判断 |
| 1158 | 11:50:13，Planner completed / ready | 双阶段比较中的第一阶段成功 |
| 1176–1178 | `facts/context.json`、`facts/comparison-links.json`、`candidate/process-index.tsv` 不可读 | 简报路径与工具根不一致 |
| 1232–1233 | `read_observation` 返回 261,126 字节 transcript 和 5,108,329 字节 run_events | 128 条记录并不意味着小输入 |
| 1238 | 原生工具回调报告该 run_events 结果 5,139,448 字节 | 序列化包装后更大；不是 128 KB 的页面 |
| 1242 | 11:50:54，Reporter session failed / protocol | 结合 comparison.json 确认上下文超限 |

全日志统计有 12 次 `controller.requested`、11 次 `input.submitted`、4 次 `controller.done_rejected`（两种原因各 2 次）、1 次 `controller.observation_read`，没有 `agent.context_compacted`。原报告中的早期 89 次拒绝属于另一实验，本计划不把它混入本次计数。

## 4. 故障机制与修复边界

本节描述测试轨迹和首次分析所对应的故障机制，不作为当前工作区仍存在全部缺陷的声明。实施前必须核对实际 diff：工作区中已能找到共享 observation 分页、Controller 纠错反馈、请求恢复与 TUI 展示相关改动。应沿这些实现补齐验收，避免重复开发或覆盖既有修改；实施状态统一由 [进度入口](../progress/MASTER.md) 承载。源码存在某项改动不等于整个方案已通过验证。

### 4.1 待办是追加集合，完成判据却把它当当前剩余集合

[controller-briefing.ts](../../src/application/controller-briefing.ts) 的 `applyControllerUnderstandingDelta` 对三个数组复用同一个更新规则：`replace` 替换，`merge` 去重追加。因此 `merge + []` 保留全部旧待办。这个函数按现有 merge 语义执行，但提示词与模型使用方式没有保证“完成事项必须通过 replace 移除”。

首次分析对应实现中，`readControllerPendingActions` 读取 ledger 的字符串数组；`verifyActiveControllerNode` 则更新 contract 节点状态。完成门不读节点是否 verified，形成两个可能分歧的事实来源。该版本读取待办还绕过了 ledger schema 校验；contract 更新的宽泛 catch 会吞掉非首次创建错误。实施核对重点是权威账本校验及投影写入中断的恢复，而非仅根据这段历史描述重做函数。

[experiment.ts](../../src/application/experiment.ts) 的 `deliverSteering` 在拒绝后直接 `run.submit` 合成用户句。结果是 Controller 的账本/证据问题变成了候选的重做指令，增加付费回合并诱发 `satisfied → no_further_value`。

### 4.2 证据门既可能误拒绝，也可能错误放行

还需处理长寿命 Controller session 与单次 request 的生命周期差异。本次唯一的 `controller.observation_read` 位于 sequence 123，绑定第 1 次 request，且 `evidenceRefs` 为空；后续决策不能据此获得本轮证据。工具回调若在 session 创建时闭包捕获 requestId，复用 session 后就可能继续归属旧请求。日志直接证明的是证据不足；闭包问题的修复应以同一 session 连续两个请求的回归验证，不能只断言“调用过 read”。

测试报告所述止损版本的 `controllerDecisionTools` 已将成功的 workspace `file_read` 映射为 `controller.observation_read`，因此不能把“没有 read_observation 工具”当作全部根因。不过当时的映射没有区分读的是 INDEX、旧历史还是当前候选产物，也没有保存所读文件的内容引用，只传空 `evidenceRefs`。

测试时拒绝上限按整个 run 累计，不是连续次数；[护栏记录](../decisions/accepted/2026-09-06-controller-completion-evidence-guard.md) 的“连续”表述需与最终实现核对。上限之后接受原 done reason 只能止损；若原 reason 为 satisfied，仍存在缺证据却进入完成状态的风险。完成门及纠错入口见 [controller-request.ts](../../src/application/controller-request.ts)。

### 4.3 Comparison 的条数分页没有控制输入体积

测试对应的观察分页入口当时在 Host 工具里对事件数组 `slice` 后 JSON 序列化；没有字节预算，也没有单条巨型事件处理。这是 5.1 MB 返回的直接实现原因。原始事件中可包含很大的工具结果或嵌套正文，不能用记录数推算模型 token。分页工具已删除，冻结历史写成 `observations/` 文件，见 [工作集与观察文件](../decisions/accepted/2026-09-07-recovery-working-set-and-observation-files.md)。

首次分析参考的 [recovery-observation-tools.ts](../../src/infrastructure/recovery-observation-tools.ts) 有 48,000 字节页面预算，可复用其思路，但不能原样照搬：该版本在页面为空时允许第一条超大记录进入，仍有单条越界缺口。

[pi-model-caller.ts](../../src/infrastructure/pi-model-caller.ts) 和 [pi-compaction.ts](../../src/infrastructure/pi-compaction.ts) 在首次分析时已有 Pi 压缩及 overflow 恢复。此次没有成功压缩事件，说明不能依赖“已有压缩”兜住超大工具输出；该版本还会把无法准备或失败的压缩折叠为 undefined。究竟是保留尾部过大、摘要请求失败、阈值判断还是恢复路径未继续，需要离线故障注入区分，日志不足以断言其中某一个。

### 4.4 Comparison briefing 与 workspace 工具采用不同根目录

[comparison-briefing.ts](../../src/application/comparison-briefing.ts) 把 facts 和 process index 写在 attempt/briefing 下；[experiment-report.ts](../../src/application/experiment-report.ts) 将 workspace 工具根设为 attempt，且 `candidate/` 挂载到候选副本。INDEX 却给出 `facts/...` 和 `candidate/process-index.tsv`。

模型按 INDEX 读取便找错位置；`candidate/` 同时被用作简报目录和真实产物目录尤其容易混淆。日志已经证明这些路径读取失败。路径失败可能促使模型使用原始 observation，放大上下文压力，但不能把这种因果推断视为确定事实。

### 4.5 状态语义与展示不一致

首次分析的 [candidate-run.ts](../../src/application/candidate-run.ts) 中，`settleController` 只在 satisfied 分支设置任务判断。[结果协议](../architecture/run-outcome.md) 规定有效 `no_further_value` / blocked 应映射为 incomplete。本实验实际落盘 indeterminate，说明实现与文档需要一并核定。

首次分析的 [controller-run.ts](../../src/tui/controller-run.ts) 中，`phaseForEvent` 只识别 Codex 的生成事件，没有 Claude 生成事件对应投影，所以 Claude 已执行工具时仍显示 candidate_starting。应使用共享 Runtime 事件语义或 Pack 已有投影能力，不能在应用层继续累加产品类型分支。

### 4.6 上游故障、环境限制与测试方法

报告记录连接探测预算由 60 秒调整为 180 秒。扩大预算只能解决慢请求，不能解决约 40 秒返回的 upstream failure。首次分析的 [pi-agent-host.ts](../../src/infrastructure/pi-agent-host.ts) 已存在 transient 重试，条件却依赖 `maxRepairAttempts > 0`，计时与取消行为也需独立验证；不应照搬[另一场 opening 失败计划](./latest-run-controller-understanding-failure-2026-09-06.md) 中“新增共享重试”的全部内容。

本实验 manifest 的 wallClock 为 24 小时、maxTargetTurns / maxModelCalls 为 256、turnTimeout 为 2 小时，内部调用预算也为 24 小时。它们不是 Reporter 超限的原因，但作为全流程 smoke 的止损界限过宽。

驱动通过 `mockTui` 输入并渲染 HTML 截图，部分返回动作直接调用 `backToHome()`；候选可用性等待条件还包含 `|| true`。这些可用于采集画面，却不能证明真实键盘导航和异步可用性状态已经通过。项目标签、默认模型别名与摘要问题属于可理解性问题，现有证据不支持把它们列为本次 stalled 的根因。

## 5. 分阶段修改计划

### 阶段 A：P0，修复比较证据读取与路径

修改位置：[observation-files.ts](../../src/application/observation-files.ts)、[comparison-briefing.ts](../../src/application/comparison-briefing.ts)、[experiment-report.ts](../../src/application/experiment-report.ts)，必要时同修 Recovery 的观察树。

1. 为 observation 页面加入序列化后的硬字节预算；初始建议沿用 48,000 字节级别，在最终 content 包装处校验，保留 `maxItems` 作为第二约束。字节数不是 token 精确值，模型请求仍需独立预算。
2. 单条超过预算时返回有 schema 的缩略条目，保留稳定 ref、原始字节数、截断原因与可继续读取的位置；正文用现有按路径/偏移读取能力访问。不能返回空页面加原 cursor 导致死循环，也不能截断 JSON 字节造成无效 JSON。
3. 原始事件仍保留在事件存储；送入模型的是明确标记的有限投影。截断前应用现有隐私规则，新增投影及内容引用进入审计，保证实际模型输入可复原。
4. INDEX 的实际读取路径统一相对 attempt 根：`briefing/facts/...`、`briefing/candidate/process-index.tsv`；`candidate/` 只表达候选副本。同步两个阶段 orientation 与提示词。
5. 先用现有 workspace reader 的分页能力，避免新增检索服务。只有无法用现有路径读取巨型正文时，才为稳定 evidence ref 增加最小解析支持。

验收：合成一个 5 MB 事件及 128 条混合事件，任一返回体都在预算内，分页能结束，ref 不错配；按生成 INDEX 的路径实际调用 plan/report 工具均成功；候选 mount 保持只读，不能由修复引入路径越界。

### 阶段 B：P0，修复 Controller 账本与拒绝反馈

修改位置：[controller-briefing.ts](../../src/application/controller-briefing.ts)、[controller-agent.ts](../../src/agents/controller-agent.ts)、[experiment.ts](../../src/application/experiment.ts)、[controller-request.ts](../../src/application/controller-request.ts)。

1. 优先保持已有协议：在提示词明确 `merge` 只追加；刷新“当前剩余待办”必须使用已有 `replace`，包含显式空数组。不要暗改 `merge + []` 的历史语义。增加与本次轨迹相同的示例，要求完成决策同时提交当前剩余事项。
2. Host 收到“已满足”却仍有待办时，将具体冲突反馈给 Controller 作有限次数修正；允许它读证据并提交 replace。仅在 Controller 明确产生新的 send 决策时投递候选。Host 不再以自己的泛化续做句替代 Controller 决策。
3. 以 ledger 的当前剩余事项作为完成门唯一来源，contract 节点是对应投影；同步清除已移除项，避免 verified 节点和 ledger 待办长期矛盾。若节点保留，校验 ID 唯一及依赖存在，不能按数组下标补 ID 导致重排后冲突。
4. 磁盘 JSON 读取/写入经过 schema；仅 ENOENT 可按兼容分支处理，损坏 JSON、EACCES 等保留错误。不得把损坏账本视为“没有待办”。
5. 为 Host 内部纠错设置明确次数和总时间预算。耗尽时以 Harness 原因终止并保留未决事项，不强行接受缺证据的 satisfied，也不把 Host 冲突记成候选自己无价值。
6. 更改完成诊断内容：记录原决策、拒绝原因、纠错次数、剩余事项和有效证据引用，不只记录 reads=0/1。新增模型反馈必须有事件，能重放到相同请求。

验收：重放第 9 次决策情景，Controller 经反馈输出 replace 空数组后停止；Host 纠错期间候选提交次数不增加；持续不修正则有界退出；blocked / requires_real_user_decision 不能被未清待办强制改成继续执行。

### 阶段 C：P0，校准证据门和结果语义

1. 给成功读取绑定 requestId、runId、实际路径或 event/artifact ref、内容 digest、观察范围。读取 INDEX、无关文件或历史输入不能自动满足本轮候选结果验收；读取有效候选结果与当前 run 观察才计入。
2. 对 shell 检查结果沿已有工具审计挂接可复原证据，不以调用过 shell 或只做 ls 作为“交付已验证”。读取发生于旧请求或旧产物版本时不能不加区分复用。
3. 对照结果协议，修正有效 done reason 到 task assessment 的映射；模型若认为交付完成应选 satisfied，no_further_value 用于任务仍有缺口而继续无益。绝不能按 rationale 关键词把 no_further_value 自动改成成功。
4. 将“模型的任务判断”和“Host 因证据不足未接受判断”分别留痕。后者可以保持 indeterminate，但必须记录 Harness 原因，不能冒充有效 Controller 结论。

验收：相同 request 读有效结果可满足证据门；只读 INDEX、跨 run ref、旧请求读取均不满足；四种 done reason 的有效映射与规范一致；纠错预算耗尽不能得到 completed。

### 阶段 D：P1，完善上下文恢复与上游失败处理

修改位置：[pi-model-caller.ts](../../src/infrastructure/pi-model-caller.ts)、[pi-compaction.ts](../../src/infrastructure/pi-compaction.ts)、[pi-agent-host.ts](../../src/infrastructure/pi-agent-host.ts)、[agent-failure.ts](../../src/infrastructure/agent-failure.ts) 及调用方。

1. 在现有 Pi 能力上验证请求前预算，涵盖系统提示、工具定义、多条并行工具结果和输出预留。阶段 A 的单页限制不能代替累计上下文检查。
2. 为压缩失败、无可摘要内容和 overflow 恢复未继续增加可区分的诊断。保留 summary + retained tail 的重放规则；不把超限正文原样交给同窗口模型反复摘要。
3. overflow 只允许在输入实际缩减后有限重试；无法缩减时产出明确的 context-budget 诊断，保留 plan、candidate 与旧成功报告。
4. 将 transient 重试与结构化输出修复次数分开。先盘点 Pi 与 Host 的现有重试，防止叠乘；共用取消感知退避与一个总 deadline，初始建议最多 3 次尝试，区分“尝试”与“额外重试”。
5. 已发生工具副作用的 Agent 请求不得整段盲重放；优先延续同一 session 的传输恢复，无法确认时返回可诊断失败。认证、协议、上下文超限与用户取消不走网络重试。
6. 探针、Recovery、Controller opening 分别展示失败阶段与可重试性。opening 最终失败要形成合法运行记录和清理结果，不降级为未经理解的候选开场，也不新增随意的运行状态。

验收：用 fake provider 测试大工具结果、窗口超限、摘要失败、503 后成功、持续 503、401、取消与 deadline。不得产生重复候选输入或重复工具副作用，真实 API 不参与默认回归。

### 阶段 E：P1/P2，修复 TUI 与全流程验收

1. 结果页与历史详情独立展示候选 task/termination 和 Comparison phase/status；Reporter 超限明确显示“比较报告生成失败”，失败诊断入口不可标成正式比较结果。
2. 运行阶段基于跨 Pack 的已有 Runtime 生命周期事件投影。若现有事件不足，先调整 [Runtime 端口](../../src/core/runtime.ts)，再同步两 Pack；应用层不判断产品类型。
3. 在非运行导航页统一 Esc 返回，先关闭帮助/详情层再回退；运行页取消仍遵循现有交互，避免把导航 Esc 误当停止实验。运行页帮助依据当前页面显示。
4. 会话摘要复用现有用户任务提取规则，防止 AGENTS.md 占据摘要；项目显示名与目录名并列明确来源；候选选择保留 requested/default 与 resolved model，不擅改推荐模型。
5. 配置页用完全遮罩，截图与错误日志不含密钥片段。只修改后续渲染与采集，不把现有敏感截图复制进受控目录。
6. 全流程回归只经公开键盘输入验证返回，移除测试判定中的恒真等待。页面到达、实验终止和比较成功分别断言；补一次真实终端交互验证，不能只用 mockTui 截图宣称端到端通过。
7. 测试运行显式记录有限预算，建议首轮复跑总时长不超过 45 分钟、候选最多 16 轮、Controller 决策最多 24 次，Host 纠错另限 2 次。该建议针对本案例 smoke，不全局降低所有任务的预算。触达预算要执行取消和清理，而不只是停止截图。

验收：Codex 与 Claude 的工具活动均能推进运行文案；Esc 回退有离线测试；failed comparison 与 stalled run 可同时看见；等待条件在状态未 ready 时确实等待，超时时用明确失败退出。

## 6. 验证与交付顺序

每阶段先提供能重现对应故障的最小回归，再改实现，不靠再次付费长跑验证猜测。优先扩展 [Controller briefing 测试](../../test/controller-briefing.test.ts)、[Agent Host 测试](../../test/agent-host.test.ts)、[比较双阶段测试](../../test/comparison-agent-phases.test.ts)、[Pi 调用测试](../../test/pi-model-caller.test.ts)、[结果页测试](../../test/result-page.test.ts)。不要把 17 MB host trace 或完整私人 PPT 数据放进 fixture。

| 顺序 | 交付 | 可以机械判断的完成条件 |
|---|---|---|
| 1 | A：有限证据页面与正确导航路径 | 巨型首条、累计超限、末页、UTF-8、隐私投影、只读挂载回归通过 |
| 2 | B+C：账本纠错、证据与结果映射 | 复现 5 项旧待办后可清账；Host 拒绝不增加 Target 输入；无证据不判完成 |
| 3 | D：上下文与请求可靠性 | 压缩/重试的失败、取消、deadline 和副作用场景均有界结束 |
| 4 | E：展示与驱动 | 两 Pack 的阶段投影、返回键、报告失败展示与真实等待通过 |
| 5 | 单次受控真实复跑 | 有正式比较结果或明确的证据不足报告；没有旧账续跑、路径失败及 context_length_exceeded |

代码修改后先运行 `npm run build`，再执行相关 `dist/test/*.test.js`；阶段交付按项目要求运行 `npm run check`。仅本规划文档修改运行 `npm run verify:docs`。不降低覆盖率门槛；若新增门禁，同次提供能让它失败的反向自动化用例。

A 改工具响应/提示词，B+C 改提示词及结果处理，D 改审计或重试协议，均应同次新增或更新对应决策记录和权威文档。计划中的方案不视为已接受 ADR。先复用已有事件和 schema，只有真实字段缺口才扩展；旧日志应继续可读，新增记录明确版本与兼容规则。

## 7. 最终验收与保留问题

最终交付需同时满足：

- Controller 能根据有效证据作出完成或未完成判断，Host 自身的纠错不会生成额外候选任务。
- 已完成事项不会由于追加账本反复出现；无法确定时明确结束为可解释的 Harness 问题。
- 大事件读取始终有界且可继续追查原文，Comparison plan/report 都能读到索引指定路径。
- Comparison 的失败与候选任务状态独立保存、展示，失败不覆盖旧成功报告。
- 日志可复原新增反馈、证据投影和压缩后的模型输入；持久化边界通过 schema 校验。
- 离线回归及工程门禁通过，再由用户授权开启真实 Runtime opt-in；真实运行保留预算、模型解析名、阶段耗时、终止原因和脱敏证据。

仍需在实现/复跑时回答：PPTX 是否真正可编辑、白底且无溢出；原任务引用的副本外参考 PPT 如何在隔离条件下提供；网关实际支持的上下文窗口与配置是否一致；此次 Pi 压缩未成功的具体分支。对这些问题，本次证据只能支持进一步验证，不能据 Controller 自述或文件扩展名下结论。

成功复跑并不要求强行判候选成功：若产物确有缺口，正确的 incomplete 加可读比较报告也比失真的 completed 更符合本计划目标。

## 8. 实施复核与失败退出

### 8.1 从工作区接续实现

开始实现时先读取相关 diff 和 [进度入口](../progress/MASTER.md)，再按第 6 节次序验证。共享分页应同时覆盖 Comparison 和 Recovery；Controller 反馈应经过当前请求上下文和事件持久化；Pi 请求恢复应在工具执行之后继续原 session。已有实现若满足这些条件，直接补足反例和缺失边界，不另建同用途 helper 或第二套重试。

账本是完成门的唯一权威输入，contract 是可重建投影。需要明确两文件写入中断时的恢复策略：完成门不能读取一份新 ledger 配一份旧 contract 后推断任务已完成，损坏的权威账本也不能被空默认值掩盖。优先复用现有原子写入和恢复机制，只有实际一致性缺口才扩展协议。

核对 [完成证据护栏决策](../decisions/accepted/2026-09-06-controller-completion-evidence-guard.md) 与 [收敛及证据边界决策](../decisions/accepted/2026-09-06-ppt-flow-convergence-and-observation-bounds.md)：实现交付时必须明确哪条规则生效。“拒绝到上限即接受 satisfied”和“纠错耗尽以 Harness 原因终止”不能同时作为有效规范。提示词、工具快照、结果协议和 TUI 文档需要跟随最终规则同步。

### 8.2 高风险验收条件

| 边界 | 最小故障输入 | 必须观察到的结果 |
|---|---|---|
| 页面体积 | 首条 5 MB，混入中文、代理对和 JSON 转义字符 | 最终文本块包装不超过 48,000 字节；偏移连续，拼接可还原经隐私处理的原文 |
| 证据归属 | 一个 session 连续处理两次 Controller 请求 | 第二次读取绑定第二次 request；旧请求、其他 run 和无关 INDEX 不能满足完成门 |
| Host 纠错 | satisfied 携带 merge 空待办，随后持续不修正 | 候选输入数量不变；纠错次数及总时间耗尽后合法终止，保留拒绝证据 |
| 账本持久化 | 损坏 JSON、拒绝访问、投影写入失败 | 返回可解释错误或按明确恢复规则重建投影；不得推断“待办为空” |
| 模型恢复 | 工具成功后响应 503，再成功；另测持续失败 | 成功工具只执行一次，用户输入只追加一次；持续失败在总预算内退出 |
| 压缩与取消 | 摘要失败、保留尾部仍超限、退避期间取消 | 不向同窗口重复提交超大输入；取消后无新增请求；诊断区分失败阶段 |
| 结果投影 | 候选 stalled，同时最新 Comparison failed，且存在旧成功报告 | 两种状态分别可见；失败诊断与旧报告入口明确区分 |
| 键盘驱动 | 候选尚未 ready，结果或历史页收到 Esc | 未 ready 时持续等待；Esc 经公开输入处理回退；超时触发失败和清理 |

以上是验收场景而非新增测试文件要求；优先放入已有最接近调用链的测试。纯文案或遮罩修改可依赖现有快照，非平凡状态逻辑必须留下能实际失败的回归。

### 8.3 真实复跑的判断标准

真实复跑前，本地构建、定向回归和工程门禁均须通过，并确认显式 Runtime opt-in 与费用预算。沿原案例选择 Codex 来源和 Claude catalog `default`，记录实际解析模型，使用独立实验目录保留原失败证据。不要以更换模型规避 Harness 的确定性缺陷。

在预算内分别检查：恢复限制是否记录、候选是否正常终止、Comparison 是否完成、公开键盘路径是否可走通。检查 PPTX 内容时验证可打开、可编辑对象、白底及版面溢出，并核对数据来源；不能以文件存在或 Controller 自述替代这些检查。

若复跑仍失败，按失败层保留当前 plan、候选副本、诊断和清理结果，停止自动启动下一次收费实验。上游失败、证据不足和产物未达标应分别报告，不统一归为“模型失败”。本规划交付只验证文档，不据此宣称代码修复或真实复跑通过。

### 8.4 预算与取消的具体接入规划

阶段 E 的有限预算必须覆盖从连接探测到比较结束的整条调用链，不能只给截图循环设置超时。沿 [TUI workflow](../../src/application/tui-workflow.ts) → [Harness agents](../../src/application/harness-agents.ts) → Recovery / Experiment / Comparison 逐层核对预算与取消所有权。复用现有 `ExperimentDefaults.policy`、Agent timeout 和实验 cancel handle；只有缺少传递通道时才扩展接口。

1. 为本案例的受控驱动显式注入总 deadline 和阶段预算，校验为有限正数。阶段超时不能重置整次实验的总预算；Host 纠错、网络退避、结构化修复也消费原剩余预算。
2. 核对生产 `createCodexTuiWorkflow` 到 `createCodexExperimentWorkflow` 的参数传递，确保测试设置实际到达候选 policy 和内部 Harness 调用，并写入可审计的运行配置。不得以驱动设置了 45 分钟就推断 manifest 的 24 小时预算已经受限。
3. [requestCancellation](../../src/tui/controller-run.ts) 的实验 handle 只能覆盖它拥有的运行。对 handle 建立前的探测和 Recovery，以及比较阶段，明确取消信号由谁保存、向谁传播、由谁等待清理；取消后禁止新的模型请求或新的候选输入。
4. 用离线延迟 provider 分别卡住探测、Recovery、候选和 Comparison，触发总预算，断言调用终止、后续请求数不再增加、清理结果可见。资源仍残留时记录具体资源和清理失败，不能把 UI 返回封面视为清理完成。
5. 驱动失败后只保存证据并退出非零状态；网络请求内的有限重试与重新发起整个收费实验分别处理，禁止通过循环 `/run` 获得隐含的新预算。

### 8.5 展示与交付复核

通用错误页标题应使用“无法继续”，再由正文区分连接探测、环境恢复、Controller 理解和比较失败；仅恢复阶段使用“无法恢复”。核对 [本地化文案](../../src/tui/i18n.ts)、错误导航及结果页，避免正文分类正确而标题仍误导。项目行展示 catalog 显示名与会话 cwd 时标明来源，窄屏也保留可访问的目录信息；不得根据显示名后缀猜测或改写真实路径。

交付按 A、B+C、D、E 划分可独立验证的改动单元；跨模块字段或提示词改动与各自 ADR、schema、快照同批交付。每单元记录对应反例和实际验证结果，所有本地验收满足后再进入单次真实复跑。用户未要求提交或 push 时，交付保持为可审阅的本地改动。

### 8.6 取消边界与驱动止损的落地要求

45 分钟计时器只有在事件循环得到执行机会时才会触发。驱动中的同步游标循环若遇到键盘输入无效、页面变化或目标索引不合法，可能持续循环而无法触发超时；截图子进程的独立 20 秒 timeout 也不等于遵守整次运行的剩余预算。这是复跑方法的风险，不是原实验 Reporter 超限的根因。

| 修改位置与顺序 | 具体工作 | 离线验收条件 |
|---|---|---|
| 1. 本地驱动的预算检查 | 保存固定 deadline，预算检查比较实际已耗时间；定时器负责及时通知，不能仅检查由定时器设置的布尔值。优先使用单调时钟，阶段切换不重置 deadline | 模拟定时器回调延迟，预算耗尽后的下一次操作仍被拒绝；不启动新的实验 |
| 2. 本地驱动的产品、项目、模型选择 | 游标移动设置与列表长度有关的有限步数，校验目标索引和每步进展；批次之间让出事件循环并检查预算 | 输入处理不移动游标、列表为空、目标越界或页面改变时明确失败；不死循环，也不误选后继续 |
| 3. 观测等待与截图 | 可取消等待和截图子进程接入总取消信号，局部 timeout 取剩余预算与阶段上限的较小值；错误经过脱敏后记录 | 在等待、截图过程中耗尽预算均能退出观测；截图失败不会掩盖主流程错误，记录不包含凭据 |
| 4. TUI 启动与关闭 | 沿 [controller-run.ts](../../src/tui/controller-run.ts) 核对 verifyCandidate、accept 和 start 的每个 await 边界；同时处理关闭导致的 generation 失效和普通 Ctrl+C，关闭等待启动 Promise、晚到 handle 的取消及最终清理 | 各 await 挂起时分别取消或关闭，返回后不进入下一阶段；晚到 handle 被取消，closing 在 cleanup 完成前不能成功 |
| 5. 比较选择与 Promise 归属 | 关闭时释放比较选择门闩；所有失效异步分支的拒绝由 workflow 或 closing 接收，不能成为未处理拒绝 | 比较选择处关闭可完成；启动失败及清理失败有可观察错误，测试中无 unhandledRejection |
| 6. Recovery 与资源残留 | 失效 Recovery 返回也必须处理 staging 清理错误；清理失败保留资源定位及重试入口。观测取消不取消必要清理 | 延迟返回的 Recovery 清理失败仍传给 closing 或明确显示；不得显示清理成功或丢弃残留引用 |

复用现有生命周期和工具取消接口，不另建任务调度器。给本地驱动留下使用假 workflow、假截图器和短预算的可运行检查，至少覆盖探测、Recovery、候选、Comparison 四个阶段。每个场景都分别断言：预算触达后的新增请求数为零、实验终态可读取、清理结果确定、进程退出符合预期。清理本身失败时允许非零退出，但必须保留残留资源信息，不能为了按时退出伪造 cleanup complete。

这些边界检查与 A–D 的模型逻辑回归共同构成真实复跑准入。`npm run check` 通过只证明其覆盖的本地检查；它不自动证明驱动整条 deadline、真实终端交互、真实网关窗口或 PPT 内容质量已经验收。涉及覆盖率的实现交付还应按项目门禁文档核对对应覆盖率检查，不能用普通测试成功推断阈值通过。
