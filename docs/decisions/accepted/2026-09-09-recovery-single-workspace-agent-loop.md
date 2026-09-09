# 决策：Recovery 单工作副本自主三轮循环

状态：accepted

取代多候选物化、Host 证据评分、三态信封和固定就绪反馈循环。历史记录见 [证据排序候选](../superseded/2026-08-19-recovery-evidence-ranked-candidates.md)、[候选选择与信息增益](../superseded/2026-08-19-recovery-candidate-selection-and-information-gain.md)、[双层评估混用业务裁决](../superseded/2026-08-18-recovery-two-layer-evaluation.md)、[任务就绪反馈循环](../superseded/2026-08-22-recovery-task-readiness-feedback-loop.md)、[Host 引导调查工具](../superseded/2026-08-18-recovery-host-guided-investigation.md)、[多假设隔离候选](../superseded/2026-08-18-recovery-isolated-candidates.md)、[recovered 带 unresolved 收成 partial](../superseded/2026-09-07-recovery-envelope-recovered-unresolved-to-partial.md) 与 [recovered 缺强证据收成 partial](../superseded/2026-09-07-recovery-recovered-without-strong-evidence-to-partial.md)。连续 Session 与七件套工作区工具仍有效，见 [连续 Session](./2026-09-08-recovery-continuous-session.md) 与 [工作集](./2026-09-07-recovery-working-set-and-observation-files.md)。实施入口见 [Recovery Agent 重构](../../plan/recovery-agent-refactor.md)。

## 问题

多候选、预设假设、独立证据评分和固定业务阶段限制 Recovery 自主恢复任务起点，并把 Host 变成第二套业务裁判。

## 决定

Recovery 使用一个连续 Session 和一个工作副本，固定进行三个 turn：理解与侦察、恢复与准备、自检与结论。每轮 prompt 只描述当轮目的，Agent 自己决定调查、修改或验证。最终结论为 `ready` 或 `blocked`，由 Agent 判断缺口是否影响任务；无关缺口可以出现在 `ready` 的 `unresolved` 中。Host 只负责不可逆安全边界、运行控制、审计、持久化和机械检查，不按证据等级、changed path 或零变更改写结论。

System Prompt 不包含任务资源清单、轮次动作或输出 JSON。任务资源由第一轮推导，输出契约由最后一轮请求提供。Agent 可在 `.reprise/recovery-work/` 留下短记录，封存前清理；必要内容由 Agent 自行迁移。机械检查失败且可修复时，把具体事实追加到同一 Session，不另开业务评审 Session。封存后的起点供 `prepareRun` 复制独立副本；复用正常时不重新恢复。

## 备选方案

**多候选与 Host 评分**：保留旧流程，但限制 Agent 自主恢复并增加业务重复判断。

**无固定 turn 的单次调用**：减少编排，但不利于在有限上下文预算下稳定完成理解、操作和自检。

## 影响

Recovery 输入去掉候选选择、业务评分字段，以及 Host 预解析的 patch/preimage/catalog。`select_recovery_candidate` 退出工具面。Provider 仍拥有 staging、fingerprint、tripwire、baseline 与 `prepareRun`，只做机械检查，不按 evidence 或 changed paths 改写结论。历史磁盘可只读兼容旧 Recovery 状态；新写入只生成 `ready` / `blocked` / `failed`。新的 Agent 信封不再使用 `recovered` / `partial` / `insufficient_evidence`。

## 验证

可观察到单 Session、单工作副本、三轮 prompt、仅末轮校验 `ready`/`blocked`，以及机械失败反馈回同一 Session。`test/architecture.test.ts` 禁止生产路径重新引入候选选择工具、证据评分否决和旧三态信封。相关 Recovery 测试与 `npm run check` 必须通过。
