# 决策：Recovery 工具面、工作集证据与任务继续门

状态：accepted
日期：2026-09-10

## 问题

Recovery 把 Host 持有的 catalog、已验证 evidence 和完整任务句留在进程内，工作集只给截断句和 observations 入口；`shell_exec` 即使 `allowShell` 为假也出现在工具列表；Host 测得的任务继续 readiness 只写入评价，不挡住自动 accept 与 Candidate 启动。模型可见能力、可复原事实和可启动 baseline 对不齐。

## 决定

Recovery 工作区工厂只在 `allowShell: true` 时注册 `shell_exec`。Controller 与 Comparison 在调用工厂时显式打开。工具列表即模型本轮可调用的能力；禁用 shell 时不得把该工具发给模型。

`shell_exec` 对凭据文件名、只读 mount 和部分网络安装字面量的拦截是命令文本匹配。它不是语义沙箱，也不替代 Provider/OS 隔离。

进模型的 Recovery 工作集含截断任务句、`observations/task/initial-input.txt` 全文路径、Playbook 元数据与 `observations/playbook.md` 路径、证据计数、最多 8 条 `evidenceRefs` 与已验证 `{ref,kind}`、以及 `observations/INDEX.md` / `INDEX.tsv`。完整 catalog、`verifiedEvidence` 正文和 Playbook 正文不进首包。Host 在物化观察树时写入任务句全文。

Provider 校验通过且 Agent 信封为 `ready` 之后，Host 必须测量任务继续 readiness。只有 readiness 为 `ready` 才能自动 `acceptRecovery` 并把 baseline 标为 `runnable: isolated`。`not_ready` 或 `blocked` 把 `runnable` 设为 `blocked`，不自动接受，也不向 Candidate 启动门放行。空路径清单仍记 `ready`。Host 不因此改写 Agent 信封的 `ready` / `blocked`。

本决定取代 [自动接受校验预览](./2026-08-31-recovery-auto-accept-validated-preview.md) 中「不要求 readiness ready」的条款，以及 [Recovery 七工具](./2026-08-31-recovery-pi-aligned-tools.md) 中「allowShell 不再作为隐藏开关」的条款。自动接受本身、以及 Controller/Comparison 的七件套（含显式 shell）仍然有效。工作集上限仍遵守 [工作集与观察文件](./2026-09-07-recovery-working-set-and-observation-files.md)。

## 备选方案

**继续可见但调用失败的 shell。** 模型会反复尝试，审计上也把未授权能力算进工具面。

**用 Agent 信封单独决定 runnable。** 结构完整但缺任务输入的 staging 会被标成可隔离启动。

**把全文 catalog 塞回工作集。** 再次触发上下文预算失败。

## 影响

[Environment §7.1](../../architecture/environment.md#71-内部工作空间与实际边界) 的工具注册、工作集字段和 baseline 发布条件。`candidateStartBlocked` 读取 `taskReadinessStatus`。空路径仍可开跑。

## 验证

`test/application/recovery-tools.test.ts`：默认不注册 `shell_exec`；`allowShell: true` 才出现。`test/application/recovery-working-set.test.ts`：截断句带 `fullTextPath`，无 playbook 正文，含薄 evidence。`test/application/codex-experiment-recovery-envelope.test.ts`：缺失 required path 时即使信封 `ready` 也不自动 accept。`test/application/experiment-operations.test.ts`：`taskReadinessStatus=not_ready` 挡住启动。反向：默认注册 `shell_exec`、或 `not_ready` 仍 `runnable: isolated` 并自动 accept，测试红。
