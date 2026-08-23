# Recovery 模块本轮修改完成度与下一阶段优化审查

> 审查日期：2026-08-21  
> 审查对象：当前工作区 Recovery 实现、已有测试、`.reprise/recovery-sample-20260819-offset5-5plus5`、当前真实 Runtime 试运行 `.reprise/recovery-sample-20260820153722`，以及此前的 Recovery 分析/决策文档。  
> 本文是审查与架构建议，不是源码修改记录。

## 1. 结论摘要

本轮修改已经把上一轮最危险的“评估结果被静默伪造/发布”和 truth fixture 不执行 perturbation 等问题明显收紧；`npm run check` 当前为 **11 个门禁通过、0 失败、0 跳过，400 tests，397 passed、3 skipped**。但 Recovery 仍处于“可靠的隔离实验编排器”而不是“可证明恢复成功的生产恢复系统”：已有真实 5+5 样本主要证明 staging、forensics 和 source 不变，不能证明语义恢复。

当前最重要的架构缺口不是再增加模型提示词，而是把**每个 case 的事件、候选、验证结果和终态绑定成可审计的闭环**，并让批量评估真正执行完整性门禁。其次应修正评估指标的语义，区分 wall-clock、模型耗时、工具耗时和候选复制耗时；最后再逐步加强 shell/网络隔离、artifact 生命周期和真实接受/回放验证。

## 2. Findings（按优先级）

### P1（已修复）：批量评估曾跳过 lifecycle integrity，当前本地 batch 路径已接入

- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\application\recovery-evaluation.ts:215-219`
- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\application\recovery-evaluation.ts:299-357`
- 位置：`C:\Users\15893\Documents\model-test\Reprise\scripts\recovery-real-5plus5.mjs:304-331`

`assertRecoveryEvaluationLifecycleIntegrity` 当前按 `caseId` 分组校验；`runRecoveryEvaluationBatch` 和 `RecoveryEvaluationBatchCase` 已接收并汇总 lifecycle events，真实 runner 也会把事件传入 batch gate。当前本地反向测试证明跨 case 混入、事件缺失和终态不一致会阻止 aggregate；真实外部 5+5 尚未重新运行，因此真实样本证据仍待补齐。

**影响**：model input、candidate created、attempt 等事件丢失、错配或重复时，aggregate 仍可能发布；批量结果无法回答“每个 row 是否由同一个 case 的完整事件产生”。

**建议**：为 `recovery.*` 事件统一增加不可变 `caseId`（必要时再加 `candidateId`），在 batch 中按 case 分组校验 `modelCalls`、候选数量、attempt duration、terminal 状态与 artifact 引用；事件缺失或无法关联时应拒绝 aggregate，不能静默跳过。新增反向测试：两 case 混入事件、少一个 model input、候选事件归属错误、attempt duration 超过 row duration 时均不得发布。

### P1（历史产物限制）：已有真实样本的 duration 指标为 0，不能作为当前性能基线

- 证据：`C:\Users\15893\Documents\model-test\Reprise\.reprise\recovery-sample-20260819-offset5-5plus5\evaluation-metrics.json`
- 对照：`C:\Users\15893\Documents\model-test\Reprise\.reprise\recovery-sample-20260819-offset5-5plus5\cases\codex-01\case.terminal.json`
- 当前生成逻辑：`C:\Users\15893\Documents\model-test\Reprise\scripts\recovery-real-5plus5.mjs:233-250`

summary 中成功 case 的内部 `evaluationRow.durationMs` 曾有约 50–120 秒，但 terminal artifact 的 `durationMs` 为 0，aggregate 的平均/P50/P95 也因此为 0。当前 `evaluationDraft` 已尝试透传 `result.evaluationRow.durationMs`，所以不能直接断言最新源码仍有同一 bug；但历史样本已经不能作为当前性能基线。

**建议**：重新生成一个带代码版本、schema 版本、runner 版本和 git 工作区摘要的样本；在 sink 层加入“draft duration 与 terminal duration 相等”的反向测试，并明确四类耗时：case wall-clock、model request、tool/forensics、candidate materialization。禁止用单一 `durationMs` 混合这些概念。

### P2（已修复）：candidate recipe digest 已包含 base/checkpoint 身份

- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\application\recovery-candidate-materialization.ts:24-30`

当前 digest 已包含 `baseDigest`、provider/schema identity 和 canonical operations；不同 checkpoint 下的相同操作序列不会再被错误地视为同一个 candidate。对应反向测试已覆盖不同 baseline 保留独立 candidate。

**后续约束**：任何新增 candidate 去重入口必须继续使用该 digest，不得退回只按 operations 去重。

### P2（边界限制仍存在）：Windows shell 是显式 capability，不是 OS sandbox

- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\infrastructure\recovery-tools.ts:1339-1373`

当前通用 `staging_shell` 默认关闭，只有 Host 显式设置 `allowShell: true` 才启用。启用后仍不是 OS sandbox：变量、通配符、间接命令、引号/Unicode 和双层 shell 解析不能仅靠 lexical deny 解决，`networkAccess` 也不能由应用层字符串检查冒充网络隔离。

**边界决策**：继续优先使用结构化只读工具；`allowShell: true` 只表示显式 capability，不宣称安全沙箱。任何网络隔离必须由 Runtime/OS provider 提供，不能在应用层伪造。

### P2（已修复，后台调度仍未实现）：cleanup primitive 已接入 terminal 生命周期

- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\infrastructure\store\experiment-store.ts:418-450`

`cleanupRecoveryArtifacts` 已按 manifest、terminal-specific TTL 和失败事件进行清理，且已接入 Recovery terminal hook，不会误删普通 artifact；artifact commit 也有 soft/hard byte budget。当前仍没有独立的后台 cleanup job 或 dry-run 调度接口，因此长时间未运行 Recovery 的实验目录仍依赖下一次受控 cleanup。

**建议**：保持 terminal cleanup 幂等、可恢复并保留审计 envelope；若未来增加后台 cleanup，必须先确认报告引用和 quota，再删除 artifact，不能把后台清理伪装成当前已有能力。

### P2：敏感文件分类是审计统计，不是访问控制

- 位置：`C:\Users\15893\Documents\model-test\Reprise\src\environment\local-workspace-provider.ts:998-1003`

当前覆盖 `.env*`、常见 credentials、私钥扩展名，且不保存路径/内容，这是正确的最小化方向。但未知 secret 格式仍可能漏检，计数也不能阻止后续工具读取。

**建议**：把 source snapshot 的 secret classification、structured read deny、shell deny、artifact redaction 统一成一个 capability policy；默认 deny，允许 provider 明确声明安全的非敏感派生事实，而不是依赖文件名猜测。

## 3.2 最新真实 Runtime 试运行：已获得新证据，但不是完整 5+5

在获得显式授权后，执行了真实模型调用。运行目录为 `.reprise/recovery-sample-20260820153722`。该次运行在 Codex 第 3 个 case 期间以非零进程状态中断，因此不能当作完整 5+5，也不能将未生成的 case 计入失败或成功。已完成的两个 case 均记录了真实 wall-clock duration（约 61.9 秒、109.5 秒），source audit 通过，且终态为 `verifier_rejected` / `no_task_path_outcome`；这说明模型确实调查并生成候选，但没有产生可由 Host 观察到的任务路径结果。

随后对单个 Codex case 做了受控重试，目录为 `.reprise/recovery-debug-codex-03`。该 case 完成了 2 次模型调用、4 个 evidence source、3 个 hypothesis 和 1 个 candidate，但仍因 `no_task_path_outcome` 被拒绝；terminal duration 为 169666 ms，分层 timing 为 `forensicsMs=247`、`modelRequestMs=131489`、`candidateMaterializationMs=10754`。这不是放宽 verifier 的理由：`no_task_path_outcome` 表示历史 completed session 缺乏可验证任务路径/真值，而不是“模型声明 recovered 就应自动通过”。

该试运行暴露的工程问题是长批次中断后的恢复性。当前 runner 已增加显式 `REPRISE_RECOVERY_EVAL_RESUME=1` 入口：它校验同一 run 的 preflight identity，读取并 schema 校验已有 `case.terminal.json`，按 evaluation alias 重建 lifecycle audit view，跳过已持久化终态，并将 resumed rows 与新 rows 一起做 aggregate integrity 校验。对 `.reprise/recovery-debug-codex-03` 的 offset=2、limit=1 受控验证已成功，`sampleCount=1`、`resumedCount=1`，未新增模型调用；原始 Recovery 事件仍保留冻结 task-case ID，alias 映射只存在于内存审计视图。

随后基于该 resume 入口完成了新的真实 5+5 运行，目录为 `.reprise/recovery-sample-20260821-5plus5-rerun`：Codex 5 个、Claude Code 5 个，共 10 个 case，10 个 terminal artifact，批次无中断完成。结果为 staging 10/10、forensics 10/10、evidence source coverage 40/40、source unchanged 10/10；平均模型调用 1.1 次，平均 terminal wall-clock 100844.2 ms，P50=67071 ms，P95=200734 ms。`verified=0`、candidate replay/truth recovery 未观测；8 个 case 进入 `pending_user_review`，4 个 case 明确因 `no_task_path_outcome` 被 verifier 拒绝。该结果证明真实 Runtime 的编排、隔离、事件和 timing 证据能够完整落盘，但不证明历史 session 的语义恢复成功。

随后使用同一 run 再次执行 `REPRISE_RECOVERY_EVAL_RESUME=1`，结果 `sampleCount=10`、`resumedCount=10`，未新增模型调用，说明已持久化 terminal case 可安全续跑。真实 5+5 已完成，但真实 Agent 语义恢复率仍不可从该样本推导；`no_task_path_outcome` 不应被放宽。

## 3. 上一轮问题闭环情况

| 上一轮问题 | 当前状态 | 复核证据 |
|---|---|---|
| terminal write 失败后继续运行并发布 aggregate | 已修复 | `recovery-evaluation.ts:348-355` 抛出持久化错误；`test/recovery-evaluation.test.ts:152-174` |
| schema-invalid draft 被伪装成 runner_crashed | 已修复 | `recovery-evaluation.ts:317-346` 使用 `evaluation_protocol_error`；对应 evaluation tests |
| truth fixture 只改 metadata、不执行 perturbation | 已修复 | `test/recovery-checkpoint-fixtures.test.ts:170-218` 实际 write/rename/delete/binary/large_repo/symlink/conflicting_evidence |
| git diff whitespace error | 已修复 | 当前 `git diff --check` 无 blank-line error，仅有换行格式提示 |
| 单 case lifecycle integrity | 已覆盖 | `test/recovery-evaluation.test.ts:284-306` |
| 多 case lifecycle integrity | 已修复（本地代码与反向测试） | `recovery-evaluation.ts` 按 `caseId` 分组校验；batch 接收并校验 lifecycle events；`test/recovery-evaluation.test.ts` 覆盖跨 case 混入与事件缺失 |

## 4. 端到端架构复核

### 4.1 Host / Orchestrator

优点是状态迁移、预算、取消、错误分类、source read-only 与 staging boundary 已被拆成明确责任；失败不再依赖模型自述。下一步应让 orchestrator 只负责状态机和事件编排，不直接承担评估聚合、shell 解析和 artifact 策略。

建议定义单一 `RecoveryCaseContext`：`runId/caseId/providerId/baseDigest/stagingId/policyVersion`，所有事件和 artifact manifest 从 context 派生，避免散落的字符串拼接。

### 4.2 Provider / staging

当前真实样本表明 staging 成功率和 source unchanged 是强项，但这只证明 provider 复制边界，不证明恢复内容可用。应把 provider contract 拆为：`freeze`、`restoreCheckpoint`、`materializeCandidate`、`verifyCandidate`、`accept`，每步输出结构化 evidence，而不是使用 `providerPreview` 作为语义成功的替代品。

### 4.3 Candidate

候选已隔离、去重并对 Windows transient filesystem error 做一次有界重试；但 candidate graph 应记录 parent/base digest、operation digest、before/after fingerprint、verification verdict。候选只能以 append-only manifest 发布，不能通过共享目录状态推断。

### 4.4 Agent / tool

模型输入审计 envelope、工具注册表和 bounded reads 是正确基础。真正的优化方向是减少自由度：结构化调查查询、固定 evidence IDs、只读事实查询、受控写入 journal；让 agent 产出“可执行计划 + 证据引用”，不要直接产出“恢复成功”。

### 4.5 Verifier / acceptance

`verified` 必须同时满足 provider 可接受、post-image 与 checkpoint truth 对齐、关键不变量通过、source 未变、artifact/event 完整。`partial` 只能进入 `pending_user_review`，不能进入 verified 指标。增加 deterministic verifier 与 product-specific semantic smoke，区分 exact restore、useful partial restore、not enough evidence、provider failure。

### 4.6 Evaluation

当前 metrics 已加入 Wilson 区间、truth recovery、rejection reason、P50/P95 等方向；但 5+5 样本仍是 `history_completed`，且已有产物 0 duration、0 verified、0 replay pass，不能把“candidate generated”解释成“恢复成功”。应固定分层：

1. provider checkpoint fidelity；
2. host orchestration correctness；
3. agent investigation/recovery correctness；
4. verifier/acceptance correctness；
5. real Runtime outcome（显式 opt-in）。

每层必须有独立 denominator；没有观测值时输出 `not_observed`，不要用 0 混淆“未测”和“失败”。

## 5. 可靠性与一致性优化

1. **事件先行**：进入模型请求前先持久化可复原 input envelope；terminal 只在所有关键 artifact/event 成功后提交。
2. **case 级 correlation**：所有 `recovery.*` payload 带 caseId；candidate/attempt 再带 candidateId/attemptId；aggregate 只消费同一 run 的闭合集合。
3. **幂等键**：`runId/caseId/phase/attempt` 组成 operationId；重复重启时读取已有 terminal，不重复调用模型。
4. **失败 taxonomy**：区分 provider、tool、model request、protocol、persistence、source tripwire、timeout/cancel；每类明确 retry policy 和最终用户含义。
5. **恢复点**：forensics、candidate materialization、model request、verification、terminal publication 都有 checkpoint；崩溃重启从最后一个 durable checkpoint 继续。
6. **预算**：统一 wall-clock、model calls、tool calls、bytes、candidate count、artifact bytes；预算耗尽进入可解释终态，不再继续隐式工作。

## 6. 安全、隐私与性能

- source 永远只读；所有写入必须在 run-owned staging/candidate root，接受写回必须是独立显式 capability。
- artifact 只保存 hash、大小、结构化事实和脱敏 envelope；禁止把 task text、transcript、路径、凭据复制到 report。
- 读取工具使用 catalog ID，不接受模型提供的任意 filesystem path；拒绝 symlink escape，并在 Windows 上测试 junction/reparse point。
- candidate 创建是最昂贵路径：先基于 evidence/operation digest 去重，再复制；大仓库采用 manifest/delta/overlay，避免每个候选全量复制。
- 对模型调用和工具输出设置 token/byte 上限，记录 truncation，不把截断结果当完整证据。
- cleanup 采用 TTL + quota 双门槛，报告引用的 artifact 延迟删除。

## 7. 分阶段实施路线

### 阶段 A：先修 correctness gate

- 将 lifecycle event 加上 caseId，并改为按 case 分组校验；把校验接入真实 batch aggregate。
- 增加 terminal duration 透传、事件/row 数量和 artifact 引用的一致性反向测试。
- 重新生成最新 5+5，写入 runner/schema/代码版本和观测缺失原因。

**完成标准**：篡改任一 case 的 model/candidate/attempt/terminal 事件会阻止 aggregate；真实 5+5 的每个 case 都能定位到完整事件链。
**截至 2026-08-20 的实施复核**：本地 batch gate、case 级 lifecycle 事件、反向测试和 terminal duration 透传已经完成并通过 `npm run check`。真实 5+5 尚未重新运行；因此“真实样本每个 case 都能定位到完整事件链”和新的性能基线仍标记为待验证，不将历史 `.reprise/recovery-sample-20260819-offset5-5plus5` 作为当前性能证据。

### 阶段 B：提高验证含金量

- 为 truth fixture 生成 expected post-image manifest 和 deterministic verifier；覆盖 write/rename/delete/binary/large_repo/symlink/conflict。
- 增加 candidate replay 和产品 smoke；接受率、回放通过率、truth exact recovery 分开统计。
- 单独运行 interrupted_checkpoint 5+5，不与 history_completed 混报。

**完成标准**：至少能区分 provider 复制成功、候选生成、语义恢复、真实回放成功四个结果。

### 阶段 C：收紧边界并控制成本

- 将 shell 默认关闭，结构化工具优先；网络默认 deny，显式 capability 才开启。
- candidate digest 纳入 base identity；实现 artifact cleanup job/terminal hook。
- 加入 artifact quota、并发上限、超时和取消的恢复测试。

**完成标准**：任意 case 都不会访问 source 或凭据；artifact 不越过 quota；重复运行幂等且不会泄漏临时目录。
**截至 2026-08-20 的实施复核**：通用 shell 已默认关闭，结构化敏感文件读取拒绝、controlled-write journal、candidate base identity、artifact soft/hard byte budget 和 terminal cleanup 已接入并有测试。`allowShell: true` 仍只是显式 capability，不宣称实现了 OS 级 sandbox；网络隔离仍需由 Runtime/OS provider 提供，不能用 lexical deny 冒充。artifact quota 当前通过 commit hard rejection 保证，不等同于后台 TTL/quota cleanup job。

### 阶段 D：真实 Runtime 证据

仅在 `REPRISE_RUN_REAL_RECOVERY_EVALUATION=1` 且本地凭据可用时运行。每次记录 provider/model、代码版本、schema/prompt policy、selection manifest hash、样本 offset/limit、失败分类；真实 Runtime 结果必须和 fixture/host 结果分开。

## 8. 验收矩阵

| 维度 | 必须验证 |
|---|---|
| 持久化 | started、input artifact、attempt、candidate、verification、terminal 顺序可重放 |
| 完整性 | 事件按 case/candidate/attempt 对齐；缺失即拒绝 aggregate |
| 安全 | source digest 不变；敏感类别不进入 artifact；symlink/junction 越界拒绝 |
| 正确性 | truth post-image exact match、关键不变量、产品 smoke |
| 评估 | 每层独立 denominator；未观测不写成 0；P50/P95 使用真实 terminal duration |
| 成本 | model/tool/bytes/candidate/artifact 预算硬上限 |
| 运维 | TTL/quota cleanup 幂等，失败有事件，报告引用可追溯 |

## 9. 当前验证证据与限制

- `npm run check`：11 通过、0 失败、0 跳过；400 tests，397 passed、3 skipped。
- 已有历史样本：`.reprise/recovery-sample-20260819-offset5-5plus5`，10 cases（Codex 5 + Claude 5）。其中 staging/forensics/source unchanged 证据较充分，但 `verified=0`、replay pass 未观测，不能推导真实恢复成功率。
- 本地 trusted checkpoint 5+5 已在当前代码上执行：Codex/Claude 各 5 个 case，共 10 个 case；checkpoint truth recovery、verified path precision 和 recall 均为 10/10，且模型调用数为 0。该结果证明 deterministic checkpoint/replay 闭环，不代表真实 Agent 语义恢复率。产物位于本机 `.reprise/recovery-checkpoint-5plus5-*` 临时目录。
- 本轮真实外部 Runtime 已完成新的 5+5（Codex 5 + Claude Code 5），并随后完成 10/10 case 的 resume 无新增模型调用验证；费用风险由显式 opt-in 控制。结果只证明编排和证据链，不代表语义恢复成功率。
- 当前工作区有大量跨模块未提交变更，本审查不把全部工作区 diff 归因于 Recovery，也没有修改源码、提交或 push。
- `npm run verify:docs` 应在本文落盘后执行；换行格式若仅出现 LF/CRLF warning，不等同于 whitespace error。

## 10. 最终判断

本轮已完成 case-scoped lifecycle integrity、terminal/metrics 透传、deterministic checkpoint verifier、本地 checkpoint 5+5 验证、完整真实 Runtime 5+5，以及已持久化 terminal case 的显式 resume/skip 入口。真实 5+5 证明模型调用、候选生成、隔离、source unchanged 和 timing 能进入完整契约；10/10 resume 验证证明已完成 case 可跳过且不新增模型调用。但 `verified=0`、replay/truth recovery 未观测，历史 completed session 仍缺少足够任务路径真值，因此真实 Agent 语义恢复率尚未形成。完成度应评为：**编排、隔离、可信 checkpoint 评估闭环、完整真实样本和批次安全续跑能力已具备；真实 Agent 语义恢复成功证据仍不足**。不得通过放宽 `no_task_path_outcome` 来提高表面成功率。真实结果必须与本地 trusted checkpoint 结果分开报告。

## 11. 第一性原理收敛版：只保留恢复闭环真正需要的能力

### 11.1 Recovery 的本质

Recovery 不是“让模型生成一个看起来合理的答案”，而是完成一个最小闭环：

```text
已知损坏状态 + 可追溯证据
        -> 隔离地提出候选修复
        -> 机械验证候选结果
        -> 只有验证通过才允许接受
```

因此只有四类能力是必要的：

1. **证据**：能知道原始状态、损坏状态和约束；
2. **隔离**：所有尝试都不修改 source；
3. **候选**：每次修复可重复、可比较、可回放；
4. **验证**：成功由机器证据决定，而不是模型自述。

事件、artifact、预算和失败分类都只是为这四件事服务；不能独立证明这四件事的设计，应删除或推迟。

### 11.2 最小目标架构

建议把 Recovery 收敛为五个边界，不再继续增加平行层次：

| 边界 | 唯一责任 |
|---|---|
| Source/Checkpoint | 只读取得可验证的基线和 truth |
| Orchestrator | 按 case 驱动阶段、预算、取消和终态 |
| Candidate | 在独立目录应用可重放操作 |
| Verifier | 对 candidate 与 truth/不变量做确定性判断 |
| Store/Evaluation | 持久化事实并计算指标 |

Agent 只是 Candidate 的提出者和 Evidence 的查询者，不拥有“成功”定义；Provider 只负责环境和候选物化，不代替 Verifier。

### 11.3 必须保留的最小优化

**必须做：**

- 所有生命周期事件带 `runId + caseId`，candidate/attempt 再带自己的 ID；
- terminal 发布前验证事件、artifact 和 row 的一一对应关系；
- source 只读，candidate 使用 run-owned staging；
- candidate 操作可重放、可去重，digest 包含 base/checkpoint identity；
- verifier 至少检查 truth/post-image、关键不变量和 source unchanged；
- 持久化失败阻止 aggregate 发布；
- 明确区分 `verified`、`partial`、`insufficient_evidence`、`provider_failure`；
- 统一有限的 model/tool/bytes/time/candidate 预算。

这些是数据不可信、结果不可复现或可能破坏 source 时必须存在的安全与正确性约束。

### 11.4 可以推迟或删除的设计

以下能力在没有对应失败证据前不应继续扩张：

- 多层 parallel evaluation abstraction；
- 复杂 candidate graph；当前一个可重放 recipe + base digest 足够；
- 通用 shell sandbox；无法可靠实现时，应减少 shell，而不是继续堆 lexical deny 规则；
- 复杂后台 cleanup scheduler；先在 terminal finalization 调用一个幂等 cleanup primitive；
- 过多分类标签；分类必须直接决定 retry、终态或用户行动，否则只保留原始 failure code；
- 没有真实数据支撑的高级统计指标；先保证 denominator、duration 和观测状态正确；
- 以模型 confidence、source unchanged 或 artifact 存在替代 verifier 结论。

### 11.5 接下来只做三件事

1. **修完整性**：把 lifecycle integrity 从单 case 测试提升为真实 batch gate，并重新生成 duration 正确的 5+5；
2. **修验证**：为 truth fixture 增加确定性 post-image/invariant verifier，再运行 candidate replay；
3. **修边界**：默认关闭通用 shell 和网络，接入 terminal cleanup；不再增加新的 Recovery 抽象。

完成这三件事之前，不应继续优化 prompt、增加更多 agent 角色或扩展指标。完成之后，再根据失败样本决定是否需要新设计。

### 11.6 克制后的完成判据

Recovery 模块达到下一阶段目标，只需满足：

- 任意 case 都能从事件日志恢复其输入、候选和终态；
- 任意 candidate 都能在不接触 source 的情况下重放；
- `verified` 必须由确定性 verifier 产生；
- batch 中一个 case 的完整性失败不会被 aggregate 掩盖；
- 重启、超时、取消、重复执行不会造成 source 写入或重复模型调用；
- 评估报告中的 0 表示真实 0，未观测值单独表示为 unavailable/not observed。

这比继续增加功能更重要，也足以支撑下一轮真实样本评估。

## 12. 对“硬性指标优先”的修正：Agent 主导，硬门禁兜底

上一节的“确定性验证”不能被理解为把 Recovery 简化成文件 diff 或规则匹配。恢复问题往往包含不完整证据、语义约束和多种合理修复，Agent 的调查、假设形成、证据权衡和候选排序仍然是核心价值。硬性指标的作用是防止明显错误和不可审计结果，不是替代 Agent 判断。

### 12.1 正确的职责分配

| 层 | 应该做什么 | 不应该做什么 |
|---|---|---|
| Agent | 调查证据、发现关联、形成假设、提出多个候选、解释取舍、识别不确定性 | 自己宣布恢复成功，绕过边界或伪造证据 |
| Host | 提供受限工具、执行预算、保存输入和过程、隔离 source、维持可恢复状态 | 代替 Agent 做所有领域推理 |
| Verifier | 拦截越界、格式错误、source 写入、明显违反硬约束的结果；提供事实反馈 | 把复杂语义恢复强行压缩成单一 exact match |
| 人或产品策略 | 在多种合理候选之间接受、拒绝或继续调查 | 仅根据模型自信度自动写回 source |

### 12.2 只设置不可妥协的硬约束

硬门禁只覆盖违反系统安全、数据一致性和明确任务约束的情况：

- source 不得被修改；
- candidate 必须位于隔离边界内；
- 工具、路径、输出和 artifact 必须符合 schema/capability；
- 输入、候选、事件和 terminal 必须可追溯；
- 超时、取消、预算耗尽和持久化失败必须有明确终态；
- 明确知道的 truth/invariant 不得被违反。

除此之外，不应预先规定“正确答案必须长什么样”。例如对于历史记录、配置迁移或部分恢复，`exact tree match` 可能只是强证据，而不是唯一可接受的语义结果。

### 12.3 让 Agent 在约束内发挥能力

建议给 Agent 的不是更多角色和更多抽象，而是更好的反馈闭环：

1. 展示当前证据及其来源、时间和可信度；
2. 允许 Agent 明确列出假设、反证和信息缺口；
3. 支持先调查、再提出候选、再根据 verifier 反馈修正；
4. 允许多个候选并列，不因第一个“看起来合理”的方案过早终止；
5. 让 Agent 自己决定是否继续搜索，但由 Host 施加硬预算；
6. 将 verifier 结果作为新证据返回 Agent，而不是直接替它做语义判定。

推荐的最小循环是：

```text
observe -> hypothesize -> investigate -> propose -> verify -> revise/stop
```

### 12.4 指标只作为兜底和观测，不作为目标函数

`truth recovery rate`、`candidate replay pass rate`、duration、candidate count 等指标用于：

- 发现退化；
- 比较不同版本；
- 识别成本异常；
- 触发人工复核或重跑。

它们不应直接驱动 Agent 追求“通过率”，也不应把 `partial` 自动判成失败。报告应保留 Agent 的理由、证据引用、不确定性和候选差异，同时用硬指标阻止不可接受的结果。

因此，成功判定应是分层的：

- **硬失败**：越界、source 改写、证据伪造、协议/持久化损坏、明确 invariant 违反；
- **Agent 判断**：语义上是否合理、哪一个候选更好、是否需要继续调查；
- **人工/产品接受**：是否真正写回或作为最终恢复结果采用。

这能同时避免两种极端：既不让 Agent 越过安全边界，也不把 Recovery 退化成僵硬的规则匹配器。

### 12.5 克制原则的最终版本

不增加“为了完整而完整”的抽象；只在真实失败样本证明存在缺口时增加约束。当前最值得做的不是扩大门禁，而是：

- 保证 Agent 看见的证据真实、完整、可追溯；
- 保证 Agent 提出的候选能隔离执行和回滚；
- 保证 verifier 给出可靠反馈；
- 保证最终写回仍由明确授权决定；
- 保证失败和不确定性不会被伪装成成功。

其余能力保持简单，等真实样本显示需要时再演进。
