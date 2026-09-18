# Recovery 结构化输出 sink

- 状态：accepted
- 日期：2026-08-18

## 背景

Recovery Agent 需要在隔离 candidate 中记录恢复清单和报告。过去
`write_recovery_manifest` 接受 JSON 字符串，同时通用 `write_file` 也能直接覆盖
`recovery-manifest.json` 或 `recovery.md`。这会绕开结构化参数的即时校验，令模型在
schema 失败后难以得到稳定、可修复的反馈。

## 决策

`write_recovery_manifest` 改为直接接受经 TypeBox `RecoveryManifestSchema` 描述的
`actions` 和 `unresolved` 参数。sink 在写入前仍使用 `Value.Check`，并拒绝非 staging
相对路径与 `.git` 路径。错误包含稳定修复码、约束说明和最小合法参数例子。

通用 `write_file` 不再允许写候选根目录的 `recovery-manifest.json` 或 `recovery.md`；
必须使用相应的专用工具。`staging_shell` 仍是受审计的逃生舱，无法可靠地静态禁止其
重定向，因此 Provider 在读取 sink 时继续做 schema、路径、实际 diff、hash 和 evidence
ownership 校验。shell 写入不构成自动接受的可信边界。

Agent 的最终 completion envelope 也采用按 `status` 分支的精确合同，而不是一个把所有字段混在一起的示意对象：`recovered` 和 `partial` 必须有 `manifestPath`、非空的 Host-owned `evidenceRefs`，其中前者的 `unresolved` 必须为空；`insufficient_evidence` 必须列出非空 unresolved，且不得携带 `manifestPath`。提示词明确数组字段不能用对象替代，并给出三个可直接复制的最小 JSON shape。该合同只改善模型返回可解析结构的可靠性，不改变 schema、evidence ownership 或 Provider verifier 的裁决。

## 后果

模型获得可直接调用的 schema，而不是需要手工转义的 JSON 字符串；普通工具调用不能
意外绕过 manifest 合同。任意 candidate 仍必须经过独立的 Provider 验证；本决策不放宽
源目录、凭据、路径边界或 recovered 声明的强证据要求。


## 候选裁决

候选完成后由 Host 的纯函数 verifier 根据候选引用的事实、实际 changed paths 和
Recovery envelope 状态给出 `verified`、`pending_user_review` 或 `rejected`。弱证据即使
候选修改通过了隔离 Provider 校验，也只能进入 `pending_user_review`；只有每个变更路径
都有强事实覆盖且 envelope 声明 `recovered` 时才可标记 `verified`。涉及路径的
`contradicted` 事实会阻止自动接受并标记 `rejected`。裁决结果和 reason code 写入
`recovery.candidate_finalized` 事件，不能由 Agent 自行声明。
