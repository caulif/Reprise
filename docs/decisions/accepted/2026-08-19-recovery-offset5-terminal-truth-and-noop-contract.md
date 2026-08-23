# 决策：Recovery offset5 终态真实性、上游重试与 no-op 语义

状态：accepted

## 背景

offset5 真实 5+5 显示，已知失败在评估 batch 中被重建为零进度，502/upstream 响应落入 `unknown` 而不重试，曾发生的工具错误还会覆盖最终上游错误；同时 report/manifest-only 候选可声明 `recovered`。

## 决定

- `RecoveryEvaluationError` 可附带 schema-validated progress draft。batch 将已知业务失败写为失败 terminal，同时保留 staging、forensics、candidate、model calls 与 duration；仅未知 crash 使用零进度 fallback。真实 5+5 runner 直接复制 `recovery-evaluation` artifact 的事实字段，而不再重新推断或硬编码。
- Pi Host 优先从安全 status/code/cause 提取 408、500、502、503、504，并映射为 `transient_upstream`；Recovery 对它与 rate limit、网络、timeout 一样最多额外调用一次。401/403、协议和未知错误不重试。
- 最终失败阶段只由最终 Agent failure kind 决定；工具故障只作为审计贡献信息，不能把最终 upstream/model 故障改为 tool failure。
- `recovered`/`partial` 必须具有 Host 观测到的非 sink task-path outcome。缺少它们的声明由 Provider verifier 拒绝；Provider-validated checkpoint 的确定性 no-op 仍走独立 Host checkpoint 路径。
- Windows `staging_shell` 明确执行 `C:\Program Files\PowerShell\7\pwsh.exe -NoProfile -NonInteractive -Command <command>`，不使用 Node 的隐式 `shell: true`；ProcessBoundaryError 继续只持久化分类、errno、可执行类型和退出类别，绝不记录完整命令、cwd 或环境。

## 验证

直接测试覆盖失败 terminal 保留进度、502 分类、模型重试、工具失败不覆盖最终失败、sink-only no-op 拒绝，以及 Windows shell 的固定 ProcessBoundary 合同。真实运行仍需要显式 opt-in。

## 补充决定：候选物化、证据质量和凭据读取边界

- Candidate recipe 按 operation sequence 的稳定序列化去重。默认初始 plan 中同质的空操作 recipe 只物化一个 execution candidate；其余 hypothesis 仍保留在 plan 中，因此 candidateCount 表示实际不同的物化 recipe，而非同一目录副本数。
- 对同一 staging 的 candidate copy 一律串行。仅 `EBUSY`、`EPERM`、`EMFILE`、`EAGAIN` 可在 100 ms 后重试一次；重试事件只记录 candidate ID、次数和 errno 类别，第二次失败仍交给既有失败终态处理。
- forensics 完成事件额外投影 source reachability、task-relevant、strong、operation-bearing 和 conflict 指标；当前 workspace 的可读性不被计为 task-relevant 历史证据。
- 结构化 `read_file` 拒绝读取 `.env`、认证/凭据 JSON、credential 名称及私钥/证书扩展名。拒绝信息仅暴露稳定类别 `credential_read_denied`，不回显请求路径或内容。

## 补充验证

- 候选物化反向测试证明复制不重叠、同质 recipe 去重，且 `EBUSY` 仅重试一次；永久错误只调用一次。
- Recovery 工具反向测试证明 credential-class 文件无法通过 `read_file` 读取。
- Recovery 编排测试证明空候选不再被伪装为多个独立可审查目录，并保持首个 execution candidate 的审查与接受闭环。

## 补充决定：评估 aggregate 完整性

- `persistRecoveryEvaluation` 在发布 aggregate 前执行 Host-owned integrity gate：拒绝重复 `caseId`、`candidateCreated` 与 `candidateCount` 矛盾、`candidateCount` 非零但未创建候选，以及 completed terminal 携带 failure code 的记录。
- integrity failure 使用稳定的 `evaluation_integrity_failed` 类别并阻止 artifact commit；不能将不一致行静默降级为 runner crash 或继续发布汇总。


## 2026-08-19 补充：敏感文件预检与 artifact 预算

- Provider 在既有 fingerprint 元数据遍历中仅聚合 `env`、`credential`、`private_key` 三类文件的数量；类别扫描不保存路径、文件名或内容，并作为 `recovery.started` 的安全审计字段写入事件。复制语义不变，结构化读取拒绝策略仍由 Recovery tools 执行。
- `recovery_*` artifact 在所属 experiment/run 的结构化 artifact 集合内实施默认 64 MiB soft / 128 MiB hard 累计预算。soft 超限写入无路径、无内容的审计事件并保留当前结构化证据；hard 超限在写入前拒绝并记录审计事件，不静默删除或导出完整 workspace。事件同时给出 dedup ratio 作为容量诊断。
- 完整 staging/candidate tree 不是 artifact export 内容；需要保留这类数据必须经过显式 debug opt-in 和独立保留策略，不能借普通 Recovery artifact 通道绕过预算。

- `staging_shell` 现在在进程启动前对已知 credential 文件类别执行最小词法 deny；这不是通用 shell 解析器，而是为了避免把“任意 shell 可绕过结构化 read_file deny”误报成安全隔离。未知动态路径仍需显式 debug/更强沙箱能力，当前不会宣称已实现完整 shell sandbox。

- 默认 retention policy 为成功 Recovery artifact 7 天、失败 artifact 30 天；`cleanupRecoveryArtifacts` 依据调用方已知 terminal status 执行到期清理。清理只删除通过 manifest 识别的 `recovery_*` payload 与相邻 manifest，并为成功或失败写入无路径审计事件，因而 crash 后不会静默吞掉清理问题。

## 2026-08-19 补充：truth-bearing checkpoint fixture 的边界

- 新增 100 个分层 checkpoint fixture（Codex/Claude Code 各 50），每例通过 TypeBox `Value.Check` 校验，并保存 baseline、truth tree hash、允许等价路径及 perturbation metadata；测试逐例验证隔离 staging 的 truth hash。
- 该数据集用于无外部费用的 Provider/checkpoint 真值回归，不等同于真实模型发布率、失败注入率或产品能力结论。真实 Runtime 分层批次、Wilson 报告和 timeout/429/502/tool-spawn/provider-reject 注入仍须显式 opt-in 后单独记录。
- 当前 cleanup 是 Host-owned、manifest 限定的可审计 primitive；未将其描述为已接入每条 Recovery terminal 路径的后台调度器。通用 shell sandbox 也未实现，现阶段只提供已知敏感类别的最小词法 deny。
