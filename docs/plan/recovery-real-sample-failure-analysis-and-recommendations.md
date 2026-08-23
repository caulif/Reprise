# Recovery Agent 最新真实 5+5 结果与高可靠恢复优化修正方案

> 状态：依据 2026-08-18 最新真实 5+5 复测，并于 2026-08-19 补充客观评估和后续修正优先级。本文是 Recovery 真实样本失败分析、最大努力恢复策略和后续优化方案的唯一整合文档；已完成的能力不再作为待办。本文不包含凭据、完整 transcript、真实 session ID、任务正文或源目录绝对路径。
>
> 最新运行：`recovery-sample-20260818-git-probe-tolerant-5plus5`。脱敏汇总在 `.reprise/recovery-sample-20260818-git-probe-tolerant-5plus5/summary.json`，每条有 baseline dossier、终态和 source audit。

## 1. 执行摘要

最新 5+5 表明 Recovery Agent 已从“弱证据样本常在 Agent 之前被阻断”推进到“绝大多数样本会在隔离环境中完成调查、提出候选并给出可审查结论”：10/10 完成 staging 和 forensics 启动，9/10 完成 forensics、调用模型并创建候选，10/10 源目录未变。

但这**不等于已经证明高恢复成功率**。当前 10 条是历史 completed session，不含任务开始时的可验证文件真值；因此 `partial`、`recovered` 和 `pending_user_review` 只能说明流程、候选与协议达到的层级，不能证明工作区已经精确回到任务起点。

要把“Agent 尽力恢复”提升为可持续验证的高可靠恢复，关键不是放宽 verifier 或强迫模型把 `partial` 写成 `recovered`，而是将恢复从纯事后推断升级为：

1. **任务开始时自动采集可证明的基线和增量证据**；
2. **由 Host 确定性地重放/验证可机械恢复部分，Agent 负责调查、归因和处理歧义**；
3. **把恢复能力拆成安全、链路可用、候选生成、机械验证和语义真值五个独立指标**；
4. **用预注册的中断真值集测量，而不是用 completed history 的状态字符串替代成功率**。

弱证据仍必须最大努力调查。证据不足只限制自动接受等级和 `verified` 声明；不能成为不创建 staging、不读已登记证据、不提出候选的理由。

## 2. 最新真实 5+5：事实、而非推断

### 2.1 批次总览

| 指标 | Codex | Claude Code | 合计 |
|---|---:|---:|---:|
| 实际样本 | 5 | 5 | 10 |
| staging 成功 | 5 | 5 | **10/10** |
| `recovery.forensics_started` | 5 | 5 | **10/10** |
| `recovery.forensics_completed` | 4 | 5 | **9/10** |
| 真实模型调用 | 4 | 5 | **9** |
| 已创建候选 | 4 | 5 | **9/10** |
| source audit 通过且源目录未变 | 5 | 5 | **10/10** |
| 总运行时长 | 343.1 秒 | 705.3 秒 | 1048.4 秒 |

所有样本均尝试 4 类证据来源，且 4 类均可用；完整 forensics 样本均建立 2 个 hypothesis，通常产生 2 个候选。这个数据证明当前 Agent 有机会发挥调查能力，并没有因弱证据被简单短路。

### 2.2 按样本终态分层

| 产品 | 结果 | 正确解释 |
|---|---|---|
| Codex | 4 条 `partial` | 完成 forensics、创建候选；缺少任务起点真值，只能待审查，不得说已验证恢复。 |
| Codex | 1 条 `preflight_failed` | `forensics_started=true`、模型调用为 0、forensics 未完成；属于逐样本 facts/preflight 层失败，不是模型语义失败。 |
| Claude Code | 2 条 `partial` | 完成调查与候选生成，处于可审查但未验证层。 |
| Claude Code | 1 条 `recovered` | 协议终态为 recovered，但独立评估仍归“证据不足，无法判断”；没有真值，不能上调为真实成功。 |
| Claude Code | 1 条 `insufficient_evidence` | Agent 已完成调查和候选工作后诚实降级，不是未尝试。 |
| Claude Code | 1 条 `agent_model_failed` | forensics 已完成且模型调用已发生；属于模型/Agent 层失败，必须与证据不足分开统计。 |

### 2.3 本轮相对上一轮的真实改进

已验证的关键改进是：Git repository、HEAD、status 与历史对象探测被拆开；可预期的 Git 非零退出被作为“事实不可用/无 HEAD”处理，而非把整个 forensics 主链路打断。上一轮 Claude 样本共同停在 `recovery_resolve_facts/filesystem_error`，模型调用为 0；本轮 Claude 5/5 完成 forensics。

这说明“最大努力”不是扩大权限，而是**不让单一辅助证据源的失效压制其他安全、已冻结的证据源**。

## 2.4 客观评估：本批次证明了什么、没有证明什么

### 已被本批次直接证明的事实

- **安全隔离有效：**10/10 的 source audit 通过且源目录未变；在本地工作区边界内，Recovery 的调查和候选操作没有写回 source。
- **最大努力链路已生效：**10/10 启动 staging 与 forensics，9/10 完成 forensics、实际调用模型并创建候选。弱证据不再成为跳过调查的默认理由。
- **Git 容错改动有效：**Claude Code 从上一轮“模型调用 0”改为本轮 5/5 完成 forensics；这支持“一个辅助 Git 事实不可用不应阻断其他已冻结证据”的设计。

### 不能由本批次推出的结论

- **不能推出真值恢复率。**9/10 创建候选是候选生成率，不是 90% 恢复成功率；10 条 completed history 也不是预注册的中断样本。
- **不能确认协议 `recovered` 就是语义恢复成功。**本轮唯一 `recovered` 没有任务起点 baseline，独立评估只能标为“无法判断”，不能计入真实成功。
- **不能从“4 类证据均可用”推出证据充分。**可用只表示读取路径存在；history、patch、preimage 与 workspace 状态之间仍可能缺少可证明的因果和时间顺序。
- **不能把 source audit 通过扩大解释为所有副作用均安全。**它只证明源目录未被写入；当前 Runtime 的外部副作用能力仍为 `unobserved`，不覆盖远端服务、IDE、浏览器、数据库或用户手工动作。
- **不能比较产品能力或速度。**Claude Code 总耗时 705.3 秒、Codex 为 343.1 秒，约为 2.06 倍；但样本任务、证据量和失败路径未配对，不能归因于产品本身。

### 从数据识别出的不足、修正方向和完成判据

| 优先级 | 观察到的问题 | 数据依据 | 修正方式 | 完成判据 |
|---|---|---|---|---|
| P0 | 仍有基础设施阻断 | 1/10 为 `preflight_failed`，未完成 forensics、未调用模型 | 将该样本的每个 facts/preflight operation、尝试次数、降级结果和稳定 failure code 从脱敏 artifact 还原；为根因写最小 fixture。对可恢复的辅助事实失败继续降级，对安全边界失败保持阻断。 | 同类 fixture 可稳定复现原失败；修复后该 fixture 到达 forensics 或给出明确不可恢复的安全拒绝；不以吞错或伪造空事实换取通过。 |
| P0 | 模型失败尚未可归因到具体 Provider 条件 | 9 次真实模型调用中有 1 条 `agent_model_failed` | 在脱敏聚合中按 `AgentFailure.kind`、attempt、是否重试、工具阶段和 fallback 结果统计；对认证、协议、工具失败提供可操作诊断，不扩大重试；仅对 timeout、限流、临时网络保留有界重试。 | 每种失败类别都有 fixture、终态、重试策略和审计字段；真实批次报告不再把模型失败笼统归为“Agent 不会恢复”。 |
| P0 | 恢复语义与终态名称容易被误读 | 1 条协议 `recovered` 仍无真值，9 条候选均未能计算正确性 | 报告层固定同时显示“协议终态”“机械 verifier 结论”“真值评估结论”；无 baseline 时把真值列标为 `not_evaluable`，不得以 `recovered` 汇总为成功。 | 每份真实样本汇总都能区分 `partial`、`pending_user_review`、协议 `recovered`、机械 `verified` 与 truth-passed；自动接受分母可单独审计。 |
| P1 | 搜索覆盖仍可能不足 | 完整样本通常只有 2 个 hypothesis、2 个候选 | 不提高无边界工具预算；依据证据冲突度、未解释路径数、候选差异度和剩余风险动态扩展分支。优先补充不同机制的候选，而不是同一猜测的改写。 | candidate graph 记录每次扩展的新增证据或差异理由；无新增信息增益时停止；复杂 fixture 能覆盖预期的独立恢复分支。 |
| P1 | 候选质量与人工审查价值未知 | 本批次没有候选选择、用户反馈或 truth outcome 的聚合 | 记录审查者选择的 candidate、接受/拒绝理由类别、后续 checkpoint 复用结果；在带隐藏真值的样本中评估 top-1、top-k 和人工辅助成功率。 | 报告能区分“生成了候选”“用户选择后通过机械验证”“隐藏真值通过”，且反馈只影响后续排序，不绕过 verifier。 |
| P1 | 性能差异缺少阶段归因 | 两产品总耗时差异明显，但样本不可比 | 将 staging、facts、模型等待、工具、verifier 和 report 的单调耗时分段记录；采用配对、同扰动 fixture 后再比较产品。 | 性能报告按 phase 和样本分层，展示中位数/分位数；不以单批总耗时给产品下结论。 |
| P2 | 历史 completed session 存在选择偏差 | 全部 10 条均为历史已完成会话，不覆盖真实中断时点 | 建立预注册中断矩阵：任务起点 checkpoint、受控扰动、隐藏 truth tree/hash、允许等价结果及 source audit；真实 Runtime 调用仍需显式 opt-in。 | 使用该矩阵发布真值恢复率、Wilson 区间、错误自动接受率和按产品/证据/中断点的失败率。 |

### 对 Agent 能力的进一步优化原则

1. **扩大调查，不扩大未经验证的写入权。**增加证据读取、交叉校验、候选分支和验证调用的能力；source 仍保持隔离，候选仍必须经过 Host verifier。
2. **让 Agent 提出可证伪的假设。**每个 hypothesis 应声明支持证据、反证、受影响路径、预期差异和下一项最有信息增益的 probe，而非只输出一个笼统修复建议。
3. **让 Host 承担确定性部分。**checkpoint、delta replay、hash/tree 比较、路径边界、artifact ownership 和外部副作用声明继续由 Host 机械执行；Agent 不应替代这些事实。
4. **优化排序，而非伪造确定性。**可使用 checkpoint、preimage、patch、Git object、冻结 observation、当前树和人工反馈来排序候选；证据弱时允许更多候选和审查，但不提升 `verified` 等级。
5. **把失败变成下一轮输入。**preflight、模型、工具和 verifier 失败均应产生结构化、脱敏的失败摘要，供下一候选或下一次人工审查使用；不能把失败信息静默丢弃。

## 3. 当前能力边界与根因

### 3.1 已经解决的链路问题

以下不再是当前主要阻塞：

- 空/无 ID 历史 observation 没有可引用的 Host-owned evidence ref；
- 弱证据、history-only 或空 transcript 在进入 Agent 前被直接放弃；
- Git unborn 或 status 不可用导致所有 forensics 失败；
- `recovered + unresolved`、未知 evidence ref 等输出合同错误反复消耗工具预算；
- 报告存在但 manifest、changed path、before/after hash 或 evidence 覆盖不一致仍被接受；
- Provider rejection、未知 Provider 异常、Agent 模型错误、工具错误和 source tripwire 被混写成一种失败；
- 恢复活动写入源目录或绕过隔离 staging。

### 3.2 高可靠恢复的主要障碍不是模型“愿不愿意尝试”

当前的 10 条没有任务起点的文件真值。即使 Agent 拥有完整 reasoning、更多工具调用和更高预算，也无法从信息论上唯一推出被覆盖、删除或在任务前已修改过的文件内容。模型可以提出合理候选，却无法将其转为可证明事实。

因此，以下两种说法都不成立：

- “证据少，所以不要恢复”；
- “让模型再多猜一些，就能让所有历史会话都精确恢复”。

正确原则是：**所有样本尽力调查；只有由证据证明的部分才自动接受；其余保留为候选、分支或用户审查。**

### 3.3 当前仍有的工程缺口

1. **单样本 facts/preflight 可靠性尚非 100%。** 本轮仍有 1/10 `preflight_failed`。它不是语义恢复失败，但若目标是高可用恢复服务，这一层必须通过精确 operation 码、重试/降级策略和固定 fixture 达到接近零阻断。
2. **模型调用层已具备分类容错。** Host 对认证、限流、临时网络、工具、超时、取消、协议和未知失败记录脱敏 `kind`；Recovery 只对 timeout、rate-limited、transient-network 及旧注入端口的未分类失败执行一次有界重试。认证、工具、协议和 unknown 不自动重试，避免无意义循环；耗尽或拒绝重试后仍保留 Host forensics/candidate 诊断并记录 machine-readable fallback，终态仍为 `agent_model_failed`，不会伪装成 `insufficient_evidence`。
3. **候选质量没有真值评估。** 9/10 有候选不等于 9/10 已正确恢复；当前只能证明候选产生率和协议可审查性。
4. **当前 2 个 hypothesis、2 个候选是最低覆盖，不是充分搜索。** 对复杂仓库、跨文件变更、生成文件或多轮工具操作，固定低数量候选可能遗漏正确分支。
5. **评估样本不是目标人群。** completed history 用于验证导入、隐私、隔离、forensics 与协议；不能替代“中断时点 + 真值 baseline”的恢复准确率实验。

## 4. 高可靠恢复应如何评估

“99%”只是愿景性说法，不作为硬性验收指标。评估必须先限定分母；建议禁止使用一个未分层的百分比，而使用以下分层指标，并在建立基线后由项目另行设定目标：

| 指标 | 推荐目标 | 分母 | 证明方法 |
|---|---:|---|---|
| 源目录安全率 | 100% | 所有恢复尝试 | source digest/tripwire 前后比较。 |
| Recovery 链路完成率 | 先测量基线，再设目标 | 有效、可 staging 的请求 | 每阶段 terminal 事件和 failure code。 |
| 最大努力 forensics 启动率 | 先测量基线，再设目标 | 未被安全边界阻断的请求 | `forensics_started`。 |
| 候选生成/受控降级率 | 先测量基线，再设目标 | 可读取的历史输入 | candidate 或明确 `insufficient_evidence`，不允许无诊断失败。 |
| 机械验证通过率 | 先测量基线，再设目标 | 强证据、可验证候选 | 哈希、Git object、manifest、测试与路径审计。 |
| 真值恢复率 | 先测量基线，再设目标 | 预注册、带任务开始真值的中断案例 | 恢复结果与冻结 baseline 的独立对比。 |
| 错误自动接受率 | 0% | 所有自动接受的 `verified` | 反向用例和隐藏真值集。 |

只有最后一项“真值恢复率”可以回答恢复是否真正成功。它不能由 `partial` 数量、模型调用成功率、source unchanged 或 Provider schema 接受率代替。

## 5. 优化修正方案

### P0：把未来恢复变成可证明的确定性流程

这是达成高可靠、可验证恢复的决定性改动，应优先于继续扩大模型 prompt 或预算。

1. **任务启动 checkpoint**
   - 在任务开始、每次 Agent 可见输入变化、每个写工具调用前后，写入 Host-owned checkpoint；
   - 记录工作区 Merkle digest、受影响路径清单、文件 hash/删除标记、Git HEAD/index/status、环境和工具版本摘要；
   - 对大文件使用 content-addressed blob 或受控 artifact ref，不把文件正文塞进事件；
   - checkpoint 写入必须原子化，并能从事件日志复原。

2. **文件增量日志（direct Recovery sink 已统一实施）**
   - `write_file`、`write_binary_file`、`write_recovery_manifest`、`write_recovery_report`、`rename_file` 和 `delete_file` 已在写前/写后记录 Host-owned、schema-validated 的 `recovery.controlled_write`：相对路径、工具、文件大小和 before/after hash；失败也留下不含错误正文的 `failed` 记录；
   - `rename_file` 记录 source/target paired delta，`write_binary_file` 保留原始 bytes 但只将 hash/size 写入事件；generated 文件可受控生成，但 generated attribution 仍需 checkpoint、候选证据和 verifier 共同完成；
   - `staging_shell` 明确标为外部/不可观测 writer，不能假装具备逐文件 journal；其后续变更仍由 candidate fingerprint、manifest 和 verifier 覆盖；
   - 已完成：首次 Recovery 模型请求的完整 context 和注册工具名写入完整性校验 artifact，并由每次请求前的 `recovery.model_input` 事件引用；direct journal 可折叠为最终 metadata delta，异常顺序会拒绝。
   - **已完成：**每个 direct sink 成功后态均将实际字节保存为 `recovery-blob-<sha256>` immutable artifact，事件只保存经 `Value.Check` 校验的 artifact ref、hash 和 size；并在保存前再次验证候选内文件未被并发改写。编排事件同时标记 Host-owned `origin`（direct write/move/delete），不把模型自述当归因证明。`before`、delete、failed 和 `staging_shell` 不伪造正文 blob。**已完成：**`LocalWorkspaceProvider.applyControlledRecoveryDelta` 在 Provider-owned 隔离副本中校验基线 digest、artifact hash/size、路径边界和 symlink，并以临时副本成功后替换的方式完成 binary/write/rename/delete 的字节级回放；缺失/篡改 artifact、越界路径和不完整 journal 均拒绝且不改变原 staging。**已完成：**模型可见输入按 retry attempt 形成 immutable artifact 版本链，Provider 已能在隔离副本中安全回放 direct delta/blob；**已完成：**每条 delta 已持久化 `checkpointId`（如有）与 `baseDigest`，回放前拒绝混合 binding、foreign checkpoint、基线不匹配，并保持失败不改变原 staging。**已完成：**补充 large-repository 与 symlink 行为 fixture；Windows 无 symlink 权限时明确 skip，不将 link 当普通文件读取。持久化记录继续通过现有 `Value.Check` 校验。

3. **确定性恢复优先**
   - 存在 checkpoint/增量日志时，Host 应先复原文件树，再由 Agent 解释差异和验证，不让模型重新猜文件内容；
   - 此路径可形成 `verified`，并应有 hash/tree 级别的机械证明；
   - Agent 仍可用于处理未受控工具、副作用、冲突和下一步建议，但不作为已记录状态的唯一恢复器。

**验收：**隐藏真值集中，断点后恢复的树 hash、受控文件 hash 和删改集与任务开始 checkpoint 一致；任何漏记录路径均使自动接受失败而不是静默成功。

### P0：消除当前 1/10 + 1/10 的链路失败面

1. **facts/preflight 的分类、重试与降级（Git facts 与 staging retry 已实施）**
   - `begin_recovery_staging` 已按既有脱敏诊断对 `retryable=true` 的失败实施一次有限重试；成功后继续 maximum-effort forensics，耗尽后保留 `preflight_failed`；
   - `recovery_resolve_facts` 已将证据目录、repository、HEAD、status 和可选 historical Git object 持久化为脱敏 operation，并写入 `recovery.forensics_completed`；每项只记录可用性、尝试次数和受限原因，绝不记录源路径、命令行或进程输出；
   - Git 非关键 probe 对进程/短暂 I/O 故障实施一次有限重试；语义性 non-zero（例如非仓库、unborn HEAD）作为事实直接降级，对不可用辅助事实保持 `available=false` 并继续其他 evidence；
   - 已完成：冻结 evidence 读取和目录遍历采用逐操作诊断、一次有限重试和反向 fixture；真正无法读取的 evidence 返回明确不可用状态并进入安全降级，不伪造为空目录或无证据。

2. **模型调用的可靠降级（第一层已实施）**
   - `agent_failure` 与 `agent_timeout` 已实行一次有上限、可审计的重试；所有尝试共享隔离 candidate 与工具预算；
   - 重试耗尽后记录 machine-readable `recovery.model_fallback`：已完成 forensics、hypothesis 数、candidate 数和模型尝试数，保留 investigation artifact 供审查；
   - 绝不把模型失败伪装为 `insufficient_evidence`，也不自动接受 candidate；
   - 后续按真实 Provider 分类补充认证/配置、限流、格式和 provider 故障的精确重试策略，避免无意义重试。

**验收：**针对每个 operation 与模型失败类别添加反向测试；同一固定 fixture 连续运行时，除明确的不可用输入外不出现未解释硬失败。

### P1：让 Agent 从“写一个候选”升级为“受证据约束的分支搜索器”

1. **候选图而非固定两个候选（候选闭环与基础停止策略已实施）**
   - Host 已按已验证 preimage、patch clue、Git HEAD、冻结 observation 和 current workspace 的事实可用性动态生成并排序候选；弱证据仍生成候选，但仅限制自动接受等级；
   - 已新增 preimage/patch/Git/observation/current 五类分支 fixture，验证最高证据分支优先且其余隔离候选保留待比较；
   - **已完成：**hypothesis、候选、证据与 review summary 已写入 candidate graph artifact，alternate branch 保留在 Provider-owned 隔离目录；Host-owned 选择、独立重执行、独立 journal/report/manifest、Provider revalidation 和仅在最新验证候选上 accept 均已闭环。**已完成基础：**每个 hypothesis 记录 Host-owned search decision（新证据增益、风险、成本、预算和停止原因）；无信息增益会停止，弱但新证据仍继续调查；预算按 hypothesis 消耗并拒绝超过剩余预算的 probe。**已完成：**用户显式 accept/reject/needs_more_evidence 可写入 schema-checked immutable feedback artifact 和 Host event，并绑定当前 staging digest；**已完成：**accept feedback 同时生成 Provider-owned reviewed staging checkpoint，供后续运行复用。
   - 允许按证据增益/风险/成本停止，而不是硬编码候选数；
   - 对冲突证据保留互斥候选，不强行合并为单一答案。

2. **证据驱动的工具策略**
   - 每个工具调用必须声明它要消除的 unresolved/hypothesis；
   - Host 根据 evidence coverage、重复查询、工具预算和新信息增益阻止无效循环；
   - 先做低成本机械证据（Git object、preimage、hash、已登记 artifact），再做昂贵 shell/test/模型动作。

3. **可验证的写入计划**
   - 每个 manifest action 包含操作、路径、before/after hash、evidence refs、预期验证；
   - Provider 必须拒绝路径集合不一致、hash 不一致、无归属 evidence、`insufficient_evidence` 修改 staging、报告和 manifest 矛盾；
   - `recovered` 只允许强证据覆盖全部受影响路径；缺少覆盖则降为 `partial`。

**验收：**构造冲突 Git/preimage/observation fixture，证明 Agent 保留分支而不伪造确定性；构造正确报告但错误文件树、manifest 漏报/多报、未知 ref、错误 hash 的反向用例，均必须拒绝。

### P1：让人类审查成为高效的最后一环，而非手工重做

- 为 `pending_user_review` 输出短、可定位的证据摘要：候选差异、证据强度、冲突点、自动验证结果、推荐动作；
- 审查者只需在候选之间选择、补充受控 baseline 或拒绝，不应阅读完整模型 transcript；
- 人类选择已写回 Host-owned `recovery.review_feedback_recorded` 事件和 immutable feedback artifact，并绑定 staging digest；已通过 Provider-owned reviewed staging checkpoint 支持跨次运行复用。
- 用接受/拒绝反馈训练评估集和 playbook，但不要将用户原始正文或凭据写入报告。

### P2：产品适配与外部工具恢复

- Codex：强化 rollout/turn context、受控工具写入、patch/preimage 与 Git commit 的绑定；不把 cwd 或模型自述直接当作事实。
- Claude Code：将 transcript、history-only、compact gap、API error 分为不同 evidence layer；不逆向猜测目录或 session slug。
- 外部命令、IDE 写入、浏览器下载、数据库和远端 API 副作用应进入“可观测性/补偿”模型，不能假装本地工作区恢复即可回滚；Runtime capability 基线已完成：Codex 与 Claude Code 均显式声明 `externalSideEffects: unobserved`，并在 Recovery 模型 context 中暴露该限制；类型合同和测试已保证 Agent 能看到该边界。Host-observable external-effect record、compensation request/result artifact 和事件、证据 ref 与 requires_review 失败策略已实现；当前 Codex/Claude Runtime 仍为 unobserved，因此不会执行或声称已完成外部补偿，真正可补偿 Runtime 仍需单独实现其受控 action。
- 对非 Git、unborn Git、大仓库、二进制/生成文件和软链接分别维护 fixture。

## 6. 分阶段实施与验收顺序

| 阶段 | 目标 | 主要交付 | 完成判据 |
|---|---|---|---|
| A | 可靠性收口 | facts operation 细分、Git/IO 有界重试、模型失败 fallback | 已完成：现有 preflight/model failure 有可复现 fixture、明确策略和反向测试；后续只修复新发现的回归。 |
| B | 可证明基线 | checkpoint、Merkle digest、文件 delta journal、blob/artifact refs | 已完成 Provider 隔离副本中的 direct delta/blob 字节级安全回放、模型输入 immutable 版本链、`baseDigest`/`checkpointId` 绑定校验及 large-repository/symlink fixture；评估输出已增加隐藏真值 exact recovery rate 与 Wilson 95% 区间。 |
| C | 强验证 | 受影响路径覆盖、tree/hash verifier、强/弱证据等级 | 伪造成功必须拒绝，正确强证据样本可获得 `verified`。 |
| D | 分支搜索 | hypothesis/candidate graph、信息增益预算、审查摘要 | 已完成候选图、alternate candidate 保留/审查摘要、Host-owned 用户选择事件、逐候选重新执行验证、Provider revalidation、feedback artifact/event 和基础信息增益/风险/成本决策；已将 accept feedback 绑定为 Provider-owned reviewed staging checkpoint，可供后续运行复用。 |
| E | 真值评估与目标校准 | ≥100 条预注册中断案例、隐藏真值、置信区间 | 报告真值恢复率、错误接受率、分层失败率；基于结果设定后续目标并继续修正。 |

每阶段都必须先跑 fixture/integration，再进行真实调用。真实调用继续保持显式 opt-in；默认路径不得产生外部费用。

## 7. 评估设计：如何证明或证伪恢复能力

### 7.1 数据集要求

至少建立 100 条案例，并按以下维度预注册分层；当前测试已覆盖 100 条隐藏真值形态的聚合与 Wilson 区间输出：

- Git 有有效 HEAD、unborn Git、非 Git；
- 单文件、多文件、删除/重命名、二进制、生成文件；
- 强 checkpoint、patch/preimage、history-only、冲突证据；
- Codex 与 Claude Code；
- 正常模型返回、超时、限流/临时错误、工具失败；
- 任务的不同中断时点，而不是只使用已完成 session。

每条必须保存：任务开始 baseline、目标恢复点、受影响路径、扰动方式、隐藏 truth tree/hash、允许的等价结果、source audit 和审查结论。

### 7.2 统计与发布规则

- 主指标：隐藏真值通过的恢复数 / 预注册有效样本数；
- 同时报 Wilson 置信区间，不以 10 条样本推断总体恢复能力；
- 单独公布安全失败、基础设施失败、模型失败、证据不足、机械 verifier rejection 和错误自动接受；
- `partial`、人工接受和 `verified` 分开报告；
- 若任一错误自动接受发生，立即停止把该策略宣传为安全自动恢复，先修复 verifier/证据覆盖。

## 8. 当前已完成能力（不重复作为待办）

- deterministic Host-owned evidence catalog 与 observation ref 闭环；
- history-only、弱证据和空 transcript 的最大努力 forensics 入口；
- staging/COW 隔离、source tripwire、路径边界与终态 artifact；
- Git repo/HEAD/status/object 分离探测及 Git 辅助事实容错；
- RecoveryResult 判别输出合同、一次 envelope-only repair 和安全 invalid-output 审计；
- 受控 `recovery-manifest.json`、changed path 精确匹配、before/after hash 和 evidence ownership 校验；
- `recovered`/`partial`/`insufficient_evidence` 的不同写入与 manifest 约束；
- Provider/verifier、Agent 模型、工具、进程、preflight 和 source safety 的失败分层；
- selection manifest、baseline dossier、逐样本 source audit、脱敏真实 5+5 聚合；
- 已知 verifier rejection 与未知 Provider 异常的独立分类；
- evidence-ranked 动态候选种子：按 preimage、patch、Git、冻结 observation、current workspace 生成隔离候选并以最高证据优先执行；弱证据不会跳过 forensics。
- 候选图与人工审查基础：未执行的 alternate candidates 不再在 finalize 时销毁，均保留为 Provider-owned 隔离分支，生成 `pending_user_review` 审查摘要并由 `recovery-candidate-graph` artifact 固化；这不是自动验证；用户选择、逐候选重执行和 Provider 验证已形成闭环，但仍不等于自动 accept。

## 9. 结论

Agent 完全应该在弱证据下尽力恢复；最新 5+5 已证明这一行为可以在不触碰源目录的前提下运行。通向高可靠恢复的路径是把 Agent 能力放在最适合的位置：它负责从多源证据中调查、提出分支、调用验证和组织审查；Host 负责不可伪造的 checkpoint、增量记录、隔离、确定性复原与严格验证。

在没有任务起点真值的历史样本上，系统应追求“最大努力且不误导”；在有 checkpoint 和隐藏真值的未来中断案例上，系统才应追求并测量可验证恢复能力，再依据结果校准后续目标。










