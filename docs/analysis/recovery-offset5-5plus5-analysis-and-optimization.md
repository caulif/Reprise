# Recovery offset5 真实 5+5 问题分析与全面优化方案

> 日期：2026-08-19  
> 样本：`.reprise/recovery-sample-20260819-offset5-5plus5`  
> 适用代码：当前工作区 Recovery 实现  
> 性质：真实历史样本的故障分析、架构收敛方案与实施验收建议；不把 completed history 当成隐藏真值恢复测试。

## 1. 执行摘要

最新 offset5 真实 5+5 说明 Recovery 的**安全外壳基本成立**，但**可靠执行、结果语义和评估闭环仍未成立**：

- 10/10 成功建立隔离 staging，10/10 源目录指纹保持不变；
- 10/10 开始 Host forensics，9/10 完成 forensics 并创建候选；
- 只有 4/10 得到结构化 Agent 完成结果，其中 3 个进入 `pending_user_review`，1 个诚实降级为 `insufficient_evidence`；
- 6/10 运行失败：1 个候选创建文件系统失败、3 个模型/上游失败、2 个被归为工具失败；
- 9 次模型调用全部只有一次尝试，包含明确的 HTTP 502/服务暂不可用，说明“有界重试”没有覆盖真实错误形态；
- 5/10 样本出现 `staging_shell` spawn error，共 8 次；
- 所有完成样本的**任务路径变化均为 0**，实际 diff 只有 `recovery.md` 和/或 `recovery-manifest.json`；其中仍有一个 Agent 声明 `recovered`；
- 顶层 `evaluation-metrics.json` 只统计出 4/10 的调查/候选覆盖，平均时长为 0，和每例机械审计矛盾，当前聚合指标不能用于判断模块表现；
- 本批次约产生 1.2 GiB 隔离数据，两个样本分别约 415 MiB 和 784 MiB，暴露出复制放大、保留策略和敏感本地文件治理问题。

因此，下阶段不应继续堆叠更多候选抽象，而应按以下顺序修复：

1. **先修评估真相源**，否则后续优化无法被可靠测量；
2. **修复 Windows shell 与进程诊断**，消除 50% 样本可见的基础设施故障；
3. **修复 502/上游故障分类和 retry**，并按最终失败原因而非“曾经有工具失败”归因；
4. **禁止无任务路径效果的 `recovered`**，把 no-op 分成“已证明无需修改”和“无法证明”；
5. **让候选生成由证据差异驱动**，而不是每例固定两个同质空操作候选；
6. **降低 staging/candidate 的复制成本与数据暴露**，补齐配额、排除、按需物化和保留策略；
7. 最后才做窄边界的架构拆分，保持 Host/Provider 的强安全边界不动。

## 2. 分析边界与不能得出的结论

### 2.1 本批次能回答什么

该批次适合回答：

- 能否安全进入隔离环境；
- forensics、工具、模型、Provider 和评估链路在哪一层失败；
- 模型输出是否符合结构化协议；
- 候选是否产生任务路径变化；
- source tripwire、artifact 和生命周期记录是否工作；
- 真实 Windows 文件系统和上游服务下的运行稳定性。

### 2.2 本批次不能回答什么

10 个样本均属于 `history_completed`，没有保存任务开始时的隐藏 truth tree/hash，也没有预注册允许的等价结果。因此不能从以下事实推导“恢复正确”：

- Agent 返回 `recovered` 或 `partial`；
- Provider 接受 manifest 的结构；
- `recovery.md` 存在；
- source 未改变；
- 候选处于 `pending_user_review`；
- 当前 workspace 看起来与历史任务描述一致。

本批次真实语义恢复率的分母仍为 0。当前可以报告流程率和故障率，不能报告真值恢复率。

## 3. 最新 5+5 的机械结果

### 3.1 汇总

| 指标 | 结果 | 解释 |
|---|---:|---|
| 样本 | 10 | Codex 5，Claude Code 5 |
| staging 成功 | 10/10 | 隔离入口稳定 |
| source unchanged | 10/10 | 安全底线通过 |
| forensics started | 10/10 | 最大努力入口生效 |
| forensics completed | 9/10 | 1 个在候选创建阶段失败 |
| candidate created | 9/10 | 与上项一致 |
| 模型调用 | 9 | 每个进入模型的样本仅 1 次 |
| Agent completed | 4/10 | 3 Codex，1 Claude Code |
| Agent failed | 6/10 | preflight 1、model 3、tool 2 |
| pending user review | 3 | 均无任务路径变化 |
| verified / accepted | 0 | 没有自动晋级 |
| task recovered paths | 0 | 所有完成候选均为 report-only/no-op |
| `staging_shell` 失败 | 8 次 / 5 个样本 | 均为 spawn error |
| 总耗时 | 406,971 ms | 每例平均约 40.7 s |
| 中位耗时 | 37,508.5 ms | 基于机械审计行，而非错误的顶层 metrics |
| 最大耗时 | 119,876 ms | codex-03 |

### 3.2 每例归因

| 样本 | 结果 | 直接现象 | 主要问题 |
|---|---|---|---|
| claude-01 | `preflight_failed` | forensics 已完成，创建候选时报 `filesystem_error`，标记 retryable，但没有重试 | 候选创建未接入有界重试；大工作区并发复制脆弱；诊断缺 errno/阶段细节 |
| claude-02 | `agent_model_failed` | 约 2.2 s 后 `Upstream request failed`，kind 为 unknown，仅调用一次 | 上游故障分类过窄，真实瞬态失败未重试 |
| claude-03 | `agent_tool_failed` | 一次 shell spawn error，最终又是 `Upstream request failed` | sticky tool flag 污染终态归因；shell 基础设施也有故障 |
| claude-04 | `insufficient_evidence` | 完成且诚实降级；一次 shell spawn error；仅写报告 | 行为安全合理，但 shell 失败降低调查能力；空操作 alternate 无实际增益 |
| claude-05 | `agent_model_failed` | `Upstream request failed`，仅调用一次 | 同 claude-02 |
| codex-01 | `partial` / review | 只有 manifest/report，无任务路径变化 | `partial` 更接近“调查结论”，不是“部分恢复”；状态命名易误导 |
| codex-02 | `recovered` / review | actions 为空、unresolved 为空、任务路径变化为 0；一次 shell spawn error | 最严重的语义漏洞：无强 no-op 证明也可声称 recovered |
| codex-03 | `partial` / review | 3 次 shell spawn error；仅报告；耗时约 120 s | 工具退化后仍长时间运行；停止策略和降级路径不经济 |
| codex-04 | `agent_model_failed` | 明确 502 service unavailable，kind 为 unknown，仅调用一次 | 502 未分类为 transient network/upstream |
| codex-05 | `agent_tool_failed` | 2 次 shell spawn error，最终明确 502 | 最终模型瞬态失败被历史 tool failure 覆盖；两类故障未分开记录 |

## 4. 根因分析

## 4.1 P0：评估流水线丢失失败样本的真实进度

### 现象

顶层 `evaluation-metrics.json` 报告：

- investigation coverage = 4/10；
- candidate generation = 4/10；
- average model calls = 0.4；
- average/p50/p95 duration 全为 0。

但 `mechanical-audit.json` 和 `recovery-evaluation` artifact 显示：

- 10/10 开始调查，9/10 完成；
- 9/10 创建候选；
- 共 9 次模型调用；
- 每例有真实 duration，总计 406,971 ms。

### 代码原因

`scripts/recovery-real-5plus5.mjs` 在 `result.failureStage` 存在时抛出 `RecoveryEvaluationError`。`runRecoveryEvaluationBatch()` 随后用 `failedEvaluationCase()` 重建失败行，而重建值固定为：

```text
forensicsStarted=false
candidateCreated=false
modelCalls=0
durationMs=0
```

同时 `evaluationDraft()` 对成功样本也把：

- `candidateCreated` 简化为 `Boolean(providerPreview)`；
- `modelCalls` 简化为 completed ? 1 : 0；
- `durationMs` 固定为 0；
- `recoveredPaths` 固定为空。

这使评估层把“业务失败”误当作“没有发生任何流程”，破坏了真实观测。

### 修复原则

- **终态和进度必须正交**：失败行也保留已经发生的 staging、forensics、candidate、model calls、duration 和 source audit；
- 只有 runner 在产生任何 draft 前崩溃时，才使用全零 fallback；
- 评估脚本不得重新推断已有 artifact 中的事实，应读取 schema-validated `recovery-evaluation` 和生命周期 artifact；
- 聚合只消费一种 canonical terminal row，不同时信任 `case.terminal.json`、`mechanical-audit.json` 和 summary 的相互推断。

### 具体修改

1. 扩展 `RecoveryEvaluationError` 或 batch case 返回协议，使“terminal failure + progress draft”可以一起返回；更简单的做法是 `run()` 始终返回完整 draft，并在 draft 中携带 terminal outcome，而不是用 throw 表达已知业务失败。
2. `failedEvaluationCase()` 仅用于未知 crash；已知 preflight/model/tool/verifier failure 使用现有进度字段生成失败 terminal。
3. `evaluationDraft()` 直接复制 `evaluationRow.modelCalls`、`durationMs`、`candidateCreated`、`recoveredPaths` 和 verification，不再硬编码。
4. 生成 metrics 前做一致性校验：
   - lifecycle 的 model attempt 数与 evaluation modelCalls 一致；
   - `candidateCreated=true` 时 candidateCount > 0；
   - duration 不得小于各 attempt duration 之和的合理下界；
   - summary 和 terminal rows 的 caseId 集合完全相同。
5. 遇到不一致时生成 `evaluation_integrity_failed`，禁止发布看似正常的 aggregate。

## 4.2 P0：瞬态上游故障被分类为 unknown，导致 retry 形同虚设

### 现象

- codex-04、codex-05 明确返回 502 / service temporarily unavailable / upstream_error；
- claude-02、03、05 返回 `Upstream request failed`；
- 这些结果的 `failure.kind` 均为 `unknown`；
- `retryableRecoveryFailure()` 只重试 `rate_limited` 和 `transient_network`，所以全部只有一次模型调用。

### 代码原因

`src/infrastructure/pi-agent-host.ts` 的分类正则覆盖 401/403、429、常见 socket/network 文本，但没有覆盖：

- HTTP 408、500、502、503、504；
- `upstream_error`；
- `service temporarily unavailable` / `upstream request failed`；
- SDK 提供的 retryable/status/cause 字段。

### 修复原则

- 优先读取结构化 status/code/retryable/cause，文本匹配只做兼容 fallback；
- 仅对明确瞬态故障重试；认证、协议、无效模型、工具参数错误不重试；
- retry 需要 jitter/backoff，但仍严格有界；
- 记录安全分类，不持久化可能含密钥的原始响应正文。

### 建议策略

```text
429                     -> rate_limited
408/500/502/503/504     -> transient_upstream
ECONNRESET/ETIMEDOUT... -> transient_network
401/403                 -> authentication
invalid schema/protocol -> protocol
AgentToolFailure        -> tool
其余                    -> unknown（不自动重试）
```

Recovery 层对 `rate_limited | transient_network | transient_upstream | timeout` 最多再尝试 1 次；退避建议 500–1500 ms 并服从总体 deadline。不要增加无界 retry 或把所有 unknown 当瞬态。

## 4.3 P0：终态失败归因使用 sticky tool flag，发生误分类

### 现象

claude-03 和 codex-05 的最终模型失败都是上游请求失败，但只要此前任意工具曾触发 `agent.tool_failed`，`experiment.ts` 就将最终 stage 设为 `agent_tool_failed`。

### 代码原因

`recoveryToolFailed` 在任何 `agent.tool_failed` 事件后永久为 true；最终失败分类没有优先使用 `recovery.failure.kind`。这把“模型在调查中遇到过一个可恢复工具错误”和“Agent 最终因工具失败终止”混为一谈。

### 修复方案

- 删除 sticky boolean 作为终态判据；
- 终态优先按 `recovery.failure.kind` 分类；
- 工具事件单独聚合为 `toolFailureCount`、`toolFailureByTool`、`lastToolFailureCategory`；
- 如果最终 failure.kind 是 upstream/network，即使之前有工具失败，终态仍为 model/upstream failed；
- 若需要表达复合故障，增加 `contributingFailures`，但保持唯一 `primaryFailureStage`。

建议主因选择顺序：

```text
source safety > cancellation > final Agent failure kind > Provider verdict > cleanup > contributing diagnostics
```

## 4.4 P0：`staging_shell` 在真实 Windows 上不可靠且不可诊断

### 现象

5/10 样本、8 次 shell 调用出现统一错误：

```text
Process boundary failed: staging_shell (spawn error).
```

失败覆盖 Codex 和 Claude Code，且连简单 Git/文件查询也会失败。这不是模型能力问题，而是 Host 工具边界问题。

### 当前诊断缺口

事件只保存 `spawn error`，没有安全的：

- errno code（如 ENOENT/EINVAL/EPERM）；
- shell kind 与可执行文件解析结果；
- cwd existence/readiness；
- abort/timeout 状态；
- 是否命中 Windows command length/quoting 问题。

因此当前不能仅凭 artifact 唯一确定是 ComSpec、cwd、参数、环境还是进程取消问题。

### 修复方案

1. Windows 不再依赖 `spawn(command, [], { shell: true })` 的隐式 shell 解析；显式解析并调用：
   - `%ComSpec% /d /s /c <command>`，或
   - 明确的 PowerShell 7 可执行文件与 `-NoProfile -NonInteractive -Command`；
   二选一形成固定产品合同，不做运行时猜测。
2. `ProcessBoundaryError` 安全暴露 `exitCategory`、`errnoCode`、`executableKind`；事件只记录这些枚举，不记录完整命令、cwd 和环境。
3. 执行前检查 staging cwd 仍存在、是目录且位于 candidate root。
4. 增加真实 Windows 集成用例：中文路径、空格路径、`git status`、管道、重定向、无匹配退出码、超时、取消和缺失 executable。
5. 将“命令非零退出”和“进程无法启动”分开。像 `rg` 无匹配、`git` 非仓库等预期非零结果应作为工具结果返回，而不是 Host 边界异常；模型才能继续推理。
6. 在 shell 修好前，优先鼓励 `list_staging`、`read_staging_file`、`inspect_git_history` 等结构化只读工具；不要让核心调查依赖自由 shell。

## 4.5 P1：无任务路径效果也可以声明 `recovered`

### 现象

所有 4 个 completed 样本的候选 diff 只包含交付文件：

- `recovery.md`；
- `recovery-manifest.json`。

扣除交付文件后，任务路径变化为 0。codex-02 仍返回：

```text
status = recovered
actions = []
unresolved = []
recoveredPaths = []
```

Provider 正确没有自动 accept，但输出语义仍会误导报告和人工审查。

### 必须区分的两类 no-op

1. **Verified no-op**：强 checkpoint/tree/hash 证明当前 candidate 已经等于目标恢复点，不需要修改；
2. **Unproven no-op**：没有足够前像，只能说没有找到安全可执行的恢复动作。

只有第一类可以成为 `recovered`，且应显式记录 `recoveryMode = verified_noop`、truth/checkpoint refs 和 verifier 结果。第二类必须是 `insufficient_evidence`，或者新设更准确的调查终态，例如 `no_safe_change_identified`，但不能叫 recovered。

### Provider/Verifier 规则

- `recovered` 至少满足以下之一：
  - 有非 sink task path outcome，且每条 action 有 Host-owned evidence、before/after hash 和 verifier 覆盖；
  - `verified_noop`，并由强 checkpoint/tree/hash 证明 candidate 与目标恢复点一致。
- `partial` 必须至少有一个已恢复任务路径；若 0 路径，只能表示“调查部分完成”，不能表示“部分恢复”。
- `actions=[] && recoveredPaths=[] && !verifiedNoop` 必须拒绝 recovered/partial，并安全降级。
- sink 文件永远不计入 recovered paths、precision/recall 或候选收益。

## 4.6 P1：forensics 的“4/4 可用”高估了有效证据

每例都显示 evidenceSourcesAvailable=4，但调查计划几乎总是固定的两个假设：

- historical observations；
- current workspace。

候选 operations 为空，且多次出现 unborn/no useful Git history。这里的“available”只是数据源能读取，不等于证据能约束目标恢复点。

### 优化为证据质量矩阵

每个 source 应同时记录：

| 维度 | 示例 |
|---|---|
| reachable | 能否读取 |
| nonEmpty | 是否有内容 |
| taskRelevant | 是否命中任务路径/时间窗 |
| reliability | weak / corroborated / strong |
| recoverability | 能否生成 byte-level operation |
| contradiction | 是否与其他 source 冲突 |
| freshness/time scope | 是否位于任务开始前后窗口 |

聚合指标改为：

- source reachability；
- task-relevant evidence coverage；
- strong evidence coverage；
- operation-bearing evidence coverage；
- conflict rate。

不能再把 current workspace 自身可读当作一份可证明历史起点的证据。

## 4.7 P1：候选图数量存在，但分支差异和信息增益不足

当前 9 个进入候选阶段的样本几乎都先创建两个通用 candidate，二者从同一 staging 拷贝，初始 operations 为空。未执行 alternate 多为同质 no-op，导致：

- candidateCount=2 看起来有分支搜索，实际没有差异；
- 大工作区被重复复制；
- review artifact 增加，但没有新增可决策信息；
- 搜索预算花在形式上的候选数，而不是证据检验。

### 优化原则

- 假设先于 candidate 物化；
- 只有当假设有不同 operation sequence、不同 base/checkpoint 或不同可证伪检查时才创建 candidate；
- 同一 baseDigest + 同一 operation digest 的候选去重；
- 无 operation 的 alternate 不物化完整目录，只保留 hypothesis node；
- 先做 cheap probe，再做 expensive copy/model invocation；
- 每个候选必须声明“它与现有候选的最小差异是什么”和“哪项检查可以淘汰它”。

### 建议候选层级

```text
Hypothesis（轻量，未物化）
  -> Probe result（只读、低成本）
    -> Candidate recipe（base + ordered operations）
      -> Materialized candidate（需要执行/验证时才生成）
        -> Verified/Review/Rejected
```

这比“每个通用假设先复制一份完整 workspace”更便宜、更清晰。

## 4.8 P1：大目录复制放大导致可靠性、性能和隐私风险

本批次 case 目录约：

- claude-01：415 MiB / 9,111 文件；
- codex-03：784 MiB / 21,830 文件；
- 全批次约 1.2 GiB。

候选创建对同一 staging 使用 `Promise.all` 并行复制。对大目录、锁定文件、深路径和杀毒软件扫描环境，这会放大 I/O 抖动和失败概率。claude-01 正是在 `recovery_create_candidates` 失败，诊断为 retryable filesystem error，却没有重试或降载。

### 优化方案

1. **先限并发**：Windows 上候选物化默认串行，至少不要对同一 source 同时完整复制两次。
2. **惰性物化**：无操作候选不复制；选为 execution candidate 后再生成。
3. **复用 Provider 能力**：优先 reflink/hardlink/COW；无法保证语义时回退到单次 copy，不自行发明虚拟文件系统。
4. **按需工作集**：在安全允许的案例，依据 task footprint 物化相关路径加必要项目元数据；无法证明完整性时仍使用 full tree。
5. **预算前置**：记录 fileCount/bytes/longestPath/locked-file risk，超过阈值进入受控 `review_required` 或使用低复制模式。
6. **有界候选创建重试**：仅对 EPERM/EBUSY/EMFILE/临时 antivirus lock 等明确瞬态错误重试一次；第二次改为串行/退避，不原样并发重跑。
7. **保留策略**：成功/失败分别配置 TTL；默认只长期保留结构化审计、hash、journal 和必要 blob，不无限保留每个完整 staging/candidate。

## 4.9 P1：本地敏感数据与 artifact 保留边界需要收紧

真实 workspace 可能包含 `.env`、本地凭据、个人文档、二进制和大批生成文件。隔离复制是 Recovery 必需能力，但不等于可以无期限复制到评估产物或让模型任意读取。

当前已将 `recovery_model_input` 改为结构化审计 envelope 和 digest，这是正确修复；仍需处理 staging/candidate 本身：

- selection/preflight 阶段扫描敏感文件类别，只记录类别和数量，不记录路径/内容；
- Provider 提供 deny-read policy：已知 credential 文件可复制用于字节一致性，但默认不可由模型读取、搜索或输出；
- events、reports、tool output 继续做 secret redaction 和最大长度限制；
- 评估归档不要复制完整 environment tree，除非显式 debug opt-in；默认导出 manifest、fingerprint、attempts、events、diff metadata 和必要 content-addressed blobs；
- 清理失败必须保持现有 `recovery.cleanup_failed` 审计，并在报告中提示人工清理；
- 对 case artifact 大小设置软/硬预算，并统计 dedup ratio。

## 4.10 P2：生命周期已补终态，但“业务状态”和“评估状态”仍需统一

当前代码已改进：

- 失败路径写 `recovery-attempts`；
- cleanup failure 不再静默吞掉；
- verified/accepted 路径可推进 `selected_checkpoint` / `accepted`；
- model input artifact 已脱敏。

但 offset5 暴露出两层状态仍可能分叉：

- `recovery-attempts.state` 能表示 `exhausted` / `candidate_pending_review`；
- `case.terminal.json` 在失败时却丢失已有进度；
- mechanical audit 再次从 baseline/artifact 推断一套状态；
- summary 又基于 mechanical audit 分组。

建议定义单一 `RecoveryRunOutcome` 作为 canonical persisted terminal：

```text
lifecycleState
primaryFailureStage?
contributingFailures[]
progress { staging, forensics, candidates, modelAttempts, duration }
verdict { insufficient | review | verified | accepted }
pathOutcomes[]
sourceAudit
truthEvaluation?  // 仅 checkpoint 数据集存在
```

`mechanical-audit`、summary、TUI 和 metrics 都是它的只读投影，不再各自推断。

## 5. 目标架构

## 5.1 不推翻现有边界

应继续保留：

- Runtime port 与两个 Pack 的产品兼容边界；
- Provider-owned staging/candidate/checkpoint/accept；
- source tripwire、路径边界、symlink 防护；
- Host-owned evidence refs、manifest/hash 验证；
- direct write journal 和 blob replay；
- 模型默认不调用、真实调用显式 opt-in；
- external side effects 默认为 `unobserved`。

## 5.2 建议的窄模块职责

不要一次把 `experiment.ts` 重写成新框架。按现有 helper 提取三个窄 runner 即可：

### A. `RecoveryForensicsRunner`

负责：

- resolve facts；
- 证据质量矩阵；
- hypothesis/probe；
- 记录可用性、可靠性和冲突；
- 不创建完整 candidate，不做模型接受。

输出 schema-validated `InvestigationResult`。

### B. `RecoveryCandidateRunner`

负责：

- recipe 去重；
- 惰性 candidate 物化；
- 模型调用与有界 retry；
- controlled writes；
- task path diff；
- 工具贡献故障记录。

每个 candidate 独立预算和 attempt log；一个 candidate 的失败不自动终止所有 alternate。

### C. `RecoveryPromotion`

负责：

- no-op 语义检查；
- verifier/provider validation；
- review summary；
- select checkpoint；
- accept / reject / review_required；
- source audit 和 external effects review。

### D. `RecoveryOrchestrator`

只负责：

- 状态推进；
- 总预算与停止策略；
- 调用上述三个 runner；
- 生成唯一 canonical terminal outcome。

它不应再次包含 Git、文件复制、prompt 或 verifier 细节。

## 5.3 数据流

```text
Frozen case + source fingerprint
  -> staging
  -> evidence quality matrix
  -> hypotheses (not materialized)
  -> cheap probes
  -> distinct candidate recipes
  -> selected recipe materialization
  -> model/tools with bounded retries
  -> controlled write journal
  -> task-path diff (exclude sinks)
  -> verifier
       -> verified change
       -> verified no-op
       -> pending review
       -> rejected
  -> selected checkpoint
  -> explicit accept
  -> canonical terminal outcome
  -> metrics/read-only reports
```

## 6. 具体实施顺序

## Phase 0：先修观测和诊断（最高优先级）

### 修改范围

- `scripts/recovery-real-5plus5.mjs`
- `src/application/recovery-evaluation.ts`
- `src/core/schema.ts`
- 对应 evaluation/script tests 和 decision record

### 任务

1. 失败 terminal 保留进度字段；
2. 删除 duration/modelCalls/candidateCreated 的硬编码；
3. canonical row 一致性校验；
4. metrics 增加 primary/contributing failure、shell failure、retry count；
5. 为当前 offset5 产物提供一个离线重算命令，不发起模型调用。

### Done-means

对 offset5 离线重算至少得到：

- forensics started 10/10；
- completed 9/10；
- candidate generated 9/10；
- modelCalls 9；
- average duration 40,697.1 ms；
- 不再出现全零 duration；
- 失败类型为 1 preflight、3 model、2 primary tool（修复归因后其中部分会变为 model + contributing tool）。

## Phase 1：修进程边界和失败分类

### 修改范围

- `src/infrastructure/process-runner.ts`
- `src/infrastructure/recovery-tools.ts`
- `src/infrastructure/pi-agent-host.ts`
- `src/application/experiment.ts`
- 对应 tests 与 decision record

### 任务

1. Windows 显式 shell executable/args；
2. 安全持久化 errno/exitCategory；
3. 502/503/504/upstream unavailable 分类为瞬态；
4. 一次有界 backoff retry；
5. 删除 sticky tool 主因判断，增加 contributing failure；
6. 候选创建 transient FS error 串行重试一次。

### Done-means

- Windows 中文+空格 staging 路径的 shell 集成用例通过；
- 502 fixture 恰好调用 2 次，401/协议/tool error 仍只调用 1 次；
- “先 tool failure、后 502”最终 primary=model/upstream，tool 只作为 contributing；
- 候选并发复制失败后以串行模式重试，仍失败则保留准确 errno category。

## Phase 2：收紧恢复语义

### 修改范围

- Recovery output schema/prompt；
- `recovery-verifier.ts`；
- Provider validation；
- report/review projection；
- 决策记录和反向测试。

### 任务

1. 引入明确 `verified_noop` 语义，或用现有字段表达同一约束；
2. 拒绝无 task path、无强 no-op proof 的 recovered/partial；
3. `partial` 至少一个 task path outcome；
4. review UI 明示“报告完成 ≠ workspace 恢复”；
5. 统计 report-only candidate rate。

### Done-means

- `actions=[] + unresolved=[] + no truth/checkpoint` 的伪 recovered 被拒绝；
- 强 checkpoint 与 candidate tree 完全一致时允许 verified no-op；
- sink-only diff 不进入 recovered paths；
- codex-02 形态必须降级为 insufficient/review，而非 recovered。

## Phase 3：提高调查与候选质量

### 任务

1. evidence quality matrix；
2. hypothesis/probe/candidate recipe 分层；
3. operation digest 去重；
4. no-op alternate 不物化；
5. 一个候选失败后可在总预算内尝试下一候选；
6. 工具不可用时切换结构化工具，并在预期信息增益不足时提前停止。

### Done-means

- 不再每例机械地产生两个同质空候选；
- candidateCount 表示不同 recipe，而不是目录副本数；
- 每个 materialized candidate 至少有不同 base、operation sequence 或 verifier probe；
- 同质 recipe 的反向测试证明会去重；
- shell 不可用时至少能完成结构化 workspace/Git 调查并给出诚实降级。

## Phase 4：成本、保留与隐私治理

### 任务

1. 串行/惰性 candidate 物化；
2. artifact export 默认不复制完整 environment；
3. TTL/大小预算/dedup；
4. credential deny-read policy；
5. 大仓库、锁定文件、深路径和杀毒软件干扰 fixture。

### Done-means

- report-only/no-op 案例不产生第二份完整 workspace；
- 评估归档大小可解释且受预算约束；
- 模型工具不能读取已知 credential 类文件；
- cleanup 与保留策略在 crash 后可审计。

## Phase 5：真值数据集与发布门槛

### 任务

- 构建 interrupted checkpoint 数据集；
- 每例保存 baseline、target truth tree/hash、允许等价结果和扰动方式；
- 覆盖 write/rename/delete/binary/symlink/large repo/conflicting evidence；
- Codex/Claude Code 分层；
- 注入 timeout/429/502/tool spawn/provider reject。

### 发布指标

必须分开报告：

1. **Safety**：source mutation rate、path boundary violation、secret leakage；
2. **Reliability**：staging/forensics/candidate/model/verifier 各阶段完成率；
3. **Truth**：exact truth recovery、path precision/recall、错误自动接受率；
4. **Review**：pending review、用户接受、replay pass；
5. **Cost**：模型调用、wall time、复制字节、artifact bytes；
6. **Calibration**：recovered/partial/insufficient 与隐藏真值的混淆矩阵。

任何错误自动接受都应阻止“安全自动恢复”发布。真实正确率只在 truth-bearing 数据集上计算并报告 Wilson 95% 区间。

## 7. 必须增加的反向测试

| 风险 | 反向用例 |
|---|---|
| 失败进度丢失 | 模型第二阶段失败，terminal 仍保留 forensics/candidate/modelCalls/duration |
| metrics 硬编码 | 2 次模型尝试、非零 duration，聚合必须精确反映 |
| 502 不重试 | 第一次 502、第二次成功，恰好两次调用 |
| 认证错误误重试 | 401 只调用一次 |
| sticky tool 误分类 | 中间 tool failed，最终 502，primary 仍为 upstream/model |
| shell spawn 不可诊断 | 缺失 executable 时 artifact 有安全 errno/exitCategory |
| Windows shell 不可用 | 中文空格路径执行最小命令成功 |
| 假 recovered | actions 空、task paths 空、无强 proof，Provider 拒绝 |
| 合法 no-op 被误拒 | checkpoint truth 与 candidate tree 相同，verified no-op 通过 |
| sink 计入恢复 | 只写 report/manifest，recoveredPaths 必须为空 |
| 同质候选浪费 | 相同 base + operation digest 只物化一次 |
| 大目录并发失败 | 模拟 EBUSY，降为串行重试一次 |
| 敏感文件读取 | 模型读取 credential 类路径被拒绝且事件不含路径/内容 |
| artifact 爆炸 | 超预算时受控停止或轻量导出，不静默复制无限数据 |
| summary/terminal 分叉 | case 集合或计数不一致时聚合失败而非发布 |

## 8. 不建议做的事情

- 不增加无界模型 retry；真实 502 只需要正确分类和一次有界重试。
- 不用更多通用状态/工作流框架替代当前简单状态机。
- 不把 shell 全部删除；先修 Windows 边界，并让核心调查有结构化工具 fallback。
- 不因本批次 `recovered` 数量少而放宽 Provider verifier。
- 不把 pending review 当成功，也不把用户接受自动当隐藏真值通过。
- 不为提升 candidateCount 固定制造候选；候选差异比数量重要。
- 不立即重写 `experiment.ts`；先修 P0 数据与错误分类，再按窄职责提取。
- 不在真实 history 样本上承诺 99% 或任何恢复率。

## 9. 优先级总表

| 优先级 | 问题 | 预期收益 | 风险 |
|---|---|---|---|
| P0 | 修 terminal/metrics 真相源 | 后续所有优化可被准确测量 | 低，主要是协议与脚本 |
| P0 | 修 Windows shell + 安全诊断 | 直接消除 5/10 样本中的工具退化 | 中，需 Windows 集成测试 |
| P0 | 502/upstream 分类与有界 retry | 提高真实模型调用完成率 | 低至中，必须防误重试 |
| P0 | 删除 sticky tool 主因 | 故障归因准确，可正确优化 | 低 |
| P1 | no-op recovered 约束 | 防止最危险的语义误报 | 中，涉及输出合同/verifier |
| P1 | 候选创建串行 retry/惰性物化 | 降低大目录失败与 I/O | 中 |
| P1 | evidence quality matrix | 让“可读”与“可恢复”分离 | 中 |
| P1 | recipe 去重和 probe-first | 提升候选实际信息增益 | 中 |
| P1 | artifact/credential/TTL 治理 | 降低本地数据暴露和磁盘成本 | 中 |
| P2 | 窄 runner 提取 | 降低 `experiment.ts` 耦合 | 中高，最后做 |
| P2 | ≥100 truth-bearing 数据集 | 建立真正恢复质量结论 | 工作量高，但不可替代 |

## 10. 下一轮真实 5+5 的最低验收

在再次付费执行真实模型前，应先满足：

1. offset5 可离线重算出一致的 terminal/metrics；
2. 502、401、tool failure、spawn error 的 fixture 全部通过；
3. Windows shell 中文/空格路径集成测试通过；
4. sink-only `recovered` 反向用例被拒绝；
5. 大目录候选不再并发全量复制两个 no-op 分支；
6. 真实运行仍需显式 opt-in，且归档策略不会默认复制完整敏感 environment。

下一轮 5+5 应关注：

- 是否仍出现 shell spawn error；
- 瞬态模型失败是否发生且仅发生一次 retry；
- primary/contributing failure 是否准确；
- materialized candidate 数和 distinct recipe 数是否一致；
- task-path-changing candidate 数；
- report-only/no-op 的降级是否诚实；
- artifact bytes 是否显著下降。

即使这些全部改善，仍只能证明运行可靠性提升。恢复正确性必须由 interrupted checkpoint 隐藏真值批次证明。

## 11. 最终结论

offset5 5+5 的核心问题不是“Agent 不够聪明”，而是三个基础层面同时限制了它：

1. **评估层把失败样本的真实进度抹成 0**，导致指标失真；
2. **执行层在 Windows shell、候选复制和上游错误分类上不可靠**，使模型无法稳定完成调查；
3. **语义层允许无任务路径效果的结果叫 recovered/partial**，使结构化完成与真实恢复混淆。

正确路线是先恢复观测真实性，再修基础设施可靠性，随后收紧恢复语义，最后提升证据驱动的候选搜索和真值评估。现有 source isolation、Host-owned evidence、controlled write journal、Provider verifier 和显式 accept 边界应继续保留，不能为提高表面完成率而放宽。
