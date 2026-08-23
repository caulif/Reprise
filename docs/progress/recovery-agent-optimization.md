# Recovery Agent 优化实施进度

## 当前目标

实施 [`Recovery Agent 最新真实 5+5 结果与高可靠恢复优化修正方案`](../plan/recovery-real-sample-failure-analysis-and-recommendations.md)，以最大努力恢复为默认策略；“99%”只是一种愿景性表述，**不是**硬性 KPI、验收阈值或成功率承诺。

## 非目标与风险边界

- 不从 completed history 的状态字符串推断语义真值恢复率。
- 不降低 source isolation、evidence ownership、manifest/hash verifier、路径边界或自动接受条件。
- 默认不执行真实 Runtime/API 调用；真实实验必须显式 opt-in 且脱敏。
- 不提交、push、reset 或清理当前已有未提交工作。

## 阶段与验收

| 阶段 | 状态 | 完成判据 |
|---|---|---|
| A：链路可靠性 | 已完成（当前 fixture 已覆盖） | 每个 facts/preflight operation 都有脱敏状态、有限重试/降级与反向 fixture；模型失败保留可审查 forensics。 |
| B：可证明基线 | 已完成（当前 fixture 已覆盖） | direct sink metadata delta、成功后态 blob/ref、Host-owned direct attribution、artifact integrity replay、模型输入 artifact ref 和 `baseDigest`/`checkpointId` binding 已具备；Provider 已提供基线校验、隔离临时副本和成功后替换的 binary/write/rename/delete 字节级 delta 回放；完整真值 fixture 已补充 large-repository 与 symlink 行为测试；真实 symlink 受 Windows 权限时明确跳过。 |
| C：强验证 | 已完成 | tree/hash、manifest、evidence ownership 和 source tripwire 强验证拒绝伪造成功。 |
| D：分支搜索与审查 | 已完成基础闭环 | 动态候选图、alternate candidate 保留、独立 review summary/graph artifact、Host-owned 选择、逐候选独立重执行、独立 journal/report/manifest 和 Provider revalidation 已具备；基础信息增益/风险/成本停止与 feedback artifact/event 已完成；反馈已可生成 Provider-owned checkpoint 并在后续运行复用。 |
| E：真值评估 | 已完成基础 | 评估模块支持隐藏真值 exact recovery rate、路径 precision/recall 和 Wilson 95% 区间；测试含 100 条 checkpoint 真值样本，真实分层数据仍持续扩充。 |

## 已完成（本目标内）

- 隔离 staging、source tripwire、Host-owned evidence catalog、checkpoint restore、严格 manifest/verifier 和失败分层基础已存在。
- staging transient failure 一次有界重试；失败保持可诊断 `preflight_failed`。
- `agent_failure` / `agent_timeout` 一次有界模型重试；耗尽后保留 forensics/candidate 诊断而不伪装成功。
- Git facts operation：证据目录、repository、HEAD、status、historical commit 的脱敏逐操作记录；辅助 Git 进程失败一次重试，non-Git/unborn 等语义退化继续 forensics。
- direct Recovery sink journal：`write_file`、manifest、report、`write_binary_file`、`rename_file` 与 `delete_file` 在写前/写后记录 schema-validated 路径、大小和 hash；rename 记录 source/target paired delta，delete 的成功后态明确为缺失；每个 direct 成功后态的实际字节均保存为 hash-addressed immutable artifact，并由 after snapshot 的 artifact ref 绑定且再次核验 hash/size；编排事件标记 Host-owned direct write/move/delete attribution；`replayControlledRecoveryDelta` 可重放有序 metadata delta；`staging_shell` 明确为外部不可观测 writer。
- staging 目录/文件读取与 Git facts 采用同样的逐操作合同：每次读取一次有限重试，耗尽后返回明确不可用而非伪造空内容，并写入 `recovery.workspace_read` 审计事件；路径与 symlink 边界仍会拒绝。
- Runtime 外部副作用能力基线：`RecoveryRuntimeCapabilities.externalSideEffects` 统一由 Runtime port 声明；Codex、Claude Code 与 fake runtime 当前均为 `unobserved`，Recovery 模型 context 据此明确本地 workspace 恢复不代表远端、IDE、browser 或 database 副作用已回滚。已实现 external-effect immutable artifact、compensation request/result artifact、Host-owned 事件和 `requires_review` 降级流程；由于 Codex/Claude Runtime 当前声明 `unobserved`，不会执行或声称已完成外部补偿。

## 下一步

1. [已完成] frozen observation 与 staging 读取均有一次有限重试、逐操作可用性/原因和可注入失败反向 fixture；模型可见结果均通过 Agent audit 和 Host 事件留痕。
2. checkpoint/delta journal：direct sink metadata delta、成功后态的 content-addressed blob artifact ref、`recovery.model_input` artifact ref 和基础 delta replay 已完成；已完成 Provider-owned 隔离树的 delta/blob 字节级恢复及篡改失败回滚；模型输入已按 retry attempt 形成 immutable 版本链；已补齐 journal 的 `baseDigest`/`checkpointId` 持久化绑定及冲突/篡改反向测试，并补充 large-repository/symlink 行为 fixture。
3. [已完成基础闭环] 以事实/证据关系生成候选图；已保留 alternate candidate、生成独立审查摘要和 graph artifact；已实现 Host-owned 用户选择事件、post-return 短生命周期 writer、逐候选独立重执行和 Provider revalidation；已实现 feedback artifact/event 回写与基础信息增益/风险/成本决策；搜索预算按 hypothesis 递减并拒绝超过剩余预算的 probe；Runtime 的 externalSideEffects 能力已进入 Agent context 并有类型/测试覆盖；feedback 已生成 Provider-owned reviewed staging checkpoint，可供后续运行复用。

## 本轮验证

- `npm run build`：通过（本轮新增 Runtime external-side-effect context 类型覆盖和按剩余预算决策后重新构建）。
- `node --test dist/test/environment.test.js dist/test/recovery-tools.test.js dist/test/codex-experiment.test.js`：通过（70 tests，69 passed，1 skipped；跳过为 Windows symlink 创建限制）。本轮新增 Provider delta 回放和篡改回滚反向测试。
- `npm run verify:docs`：通过。
- Recovery evaluation 新增 100 条隐藏真值聚合测试及 Wilson 95% 区间输出。
- `npm run check`：历史一次检查曾因 Recovery system prompt snapshot drift 失败；该漂移已按独立提示词契约变更处理并同步 snapshot，不是用更新 snapshot 掩盖行为回归。当前最新检查已恢复为 11 个门禁通过、0 失败、0 跳过。








## 最新验证补充（2026-08-19）

- 已将 Recovery prompt 的候选隔离、history-only 证据边界、外部副作用能力声明和弱证据最大努力要求固化到专用决策记录，并同步 `test/snapshots/recovery-system-prompt.txt`；这不是放宽安全边界。
- `npm run build`：通过。
- Recovery 定向测试：62 passed，0 failed。
- `npm run verify:docs`：通过。
- `npm run check`：11 个门禁通过，0 失败、0 跳过；全量测试 370 项，368 passed、2 skipped（Windows symlink 权限限制）、0 failed。
- 仍不把历史 completed session 当作任务起点真值，也不把当前 `unobserved` 外部副作用能力声明当作已补偿；真实 Runtime/API 仍需显式 opt-in。

- 新增模型失败分类闭环：Pi Agent Host 记录 authentication、rate_limited、transient_network、tool、timeout、cancelled、protocol、unknown；Recovery 仅对安全可重试类别执行有限重试，未知和认证类不误重试；对应反向测试已通过。


## offset5 后续收紧（2026-08-19）

- 已完成：同 staging candidate 物化改为串行，按 operation recipe 去重；同质空候选只保留一个实际 execution candidate，`EBUSY`/`EPERM`/`EMFILE`/`EAGAIN` 有一次 100 ms 有界重试，并记录无路径 retry 审计。
- 已完成：forensics completion 增加证据质量投影（可达、任务相关、强证据、可产生操作、冲突率），不再把 current workspace 的可读性当作历史真值证据。
- 已完成：结构化 `read_file` 阻断已知 credential 类文件的模型读取；拒绝只暴露类别，不写路径或内容。
- 未完成且不能以现有 completed-history 样本宣称完成：artifact TTL/大小预算、完整 shell policy sandbox、全量 truth-bearing 真实数据集及发布阈值。后续必须以新的受控设计和反向测试推进，不能用文档声明替代实现。
- 新增评估 aggregate integrity gate：发布前拒绝重复 caseId、candidateCreated/candidateCount 矛盾和 completed/failureCode 矛盾；对应反向测试已通过。

- 已完成 P1 的预检敏感类别计数：扫描仅记录 env/credential/private_key 的计数，事件不含路径或内容；同一遍历复用 fingerprint metadata，不新建全树扫描。
- 已完成基础 Recovery artifact 累计预算：默认 64 MiB soft / 128 MiB hard，soft/hard 都有无敏感信息审计，hard 在写前拒绝；容量事件含 dedup ratio。尚未实现 TTL 清理执行器，现有 cleanup failure 审计保持不变。

- 已补 TTL cleanup primitive：成功 Recovery artifact 默认 7 天、失败默认 30 天；清理基于 schema-checked manifest，只删 `recovery_*` payload/manifest，并分别审计完成和失败。
- Windows shell 矩阵补充：管道/重定向、非零退出结果、超时、缺失可执行文件（Windows）均有测试；非零退出不再误报为 Host spawn failure。
- evaluation aggregate 现在可对单 case 的 lifecycle events 交叉校验模型请求次数、candidate 数及 attempt duration 下界；业务行改为记录真实 `modelAttempts`，不再把有重试的运行固定写成 1。

## 2026-08-19 Phase 5/6 收口

- 已新增 `test/fixtures/recovery-truth-dataset.json`：100 个 schema-checked checkpoint fixture，Codex/Claude Code 各 50 例，覆盖 write、rename、delete、binary、symlink、large repository 和 conflicting evidence；每例包含 baseline files、truth tree hash、允许等价路径和扰动说明。该 fixture 是 Provider/checkpoint 真值基线，不是已付费的真实 Runtime 恢复率样本。
- `test/recovery-checkpoint-fixtures.test.ts` 会逐例恢复隔离 staging 并按 truth hash 校验；Windows 无 symlink 权限时仅跳过该能力，不将其计为通过。
- timeout、429/502、tool spawn、provider reject 的分类、有限 retry、shell 缺失 executable 与敏感文件 deny 已由现有 Recovery/Host 反向 fixture 覆盖；真实 Runtime 仍保持显式 opt-in。
- 发布时继续分离 safety、reliability、truth、review、cost、calibration；任何错误自动接受均不得晋级为安全自动恢复。Wilson 95% 区间仅对 truth-bearing checkpoint population 计算。
- 尚未宣称已完成的边界：真实 Codex/Claude Runtime 的分层发布批次与失败注入运行、通用 shell sandbox、以及由实际 terminal 流程驱动的 TTL 清理调度。当前实现提供受控 fixture、词法 credential deny 和可审计 cleanup primitive，不能把这些替代品描述为真实线上测量。
