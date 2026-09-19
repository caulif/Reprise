# 架构总览

Reprise 把历史会话冻结为 `TaskCase`，在当前机器上准备一个隔离工作区，运行一个候选 Runtime，再按需生成 Comparison。事件日志是运行事实的主要来源；TUI 和报告都读取这些事实，不拥有实验状态机。

## 层次与责任

```text
CLI / TUI
  -> application workflow
     -> ExperimentStore（单写者事件日志、attempt/manifest/artifact）
     -> LocalWorkspaceProvider（基线、恢复、候选副本、释放）
     -> CandidateRun（状态机、投递、回合结算、终止）
     -> ProductRuntime / ProductPack（当前产品协议）
  -> Controller / Recovery / Comparison Agent（内部会话）
```

Core 定义 [schema](../../src/core/schema.ts)、[状态转换](../../src/core/state-machine.ts) 和 [Runtime 端口](../../src/core/runtime.ts)。Application 负责编排和把事实写入 Store。Infrastructure 负责文件、进程、锁和 Agent Session。Product Pack 只解释产品私有的历史会话和当前 Runtime 协议；它不选择 Controller/Comparison 策略，也不安装或切换 Runtime。

## 主链

1. 从历史目录导入并冻结 `TaskCase`；来源 Runtime 信息只作为历史证据。
2. `LocalWorkspaceProvider` 检查来源目录，按预算建立恢复 staging 或 checkpoint，并形成 baseline。
3. 对每个 `runId` 验证候选 Runtime，准备隔离副本并写入候选启动上下文。候选进程只在该副本中运行。
4. `CandidateRun` 记录投递、turn settlement、任务判断、终止和 cleanup。Controller 在 opening 以及后续 settled turn 上参与，Controller 工具可以按规则读写工作副本和记录观察。
5. 候选完成后保留 `RunRecord`。Comparison 是独立的、可选的 attempt，读取冻结观察和候选证据并生成报告。

准备阶段的异常目前可能发生在 `RunAttempt` 建立之前；这意味着部分 preflight 失败没有统一的 attempt 记录。该缺口属于可观测性问题，不能在本篇描述成已有统一终态。

## Pack 边界

`ProductRuntime` 提供当前可用产品、模型目录、候选校验、Runner 创建和 Recovery 能力声明。Runner 负责 start/send、turn 等待、取消等待、inspect、stop、close，并返回 delivery receipt。Pack 不恢复历史 Runtime，不下载依赖，不决定隔离策略或报告内容。

历史来源版本与当前执行版本不是同一事实。当前代码保存产品、可执行文件、请求模型和 Runtime 解析出的模型；没有通用 `ExecutionRuntimeFingerprint`、`runtime_drift` 或 `FidelityAssessment` 管线，未知值必须保持未知。

平台实现以 Windows 11 为已验证平台。通用 shell 工具在 Windows 选择 System32 PowerShell，普通进程仍以 file + argv 启动；Recovery 工作区工具有自己的 `pwsh` 优先发现与 Windows PowerShell 回退路径，二者不能合写成一个统一发现链。

## 不变量

- 实验目录由单一 Store writer 锁保护；事件追加前校验 schema，读取时校验 checksum 和顺序。
- attempt 先于 manifest；JSON 持久化、模型输出和外部 JSON 经过 `Value.Check`。
- CandidateRun 状态变化只能经过 `assertTransition`；任务 outcome、termination 和 cleanup 是不同事实。
- 候选工作区与用户 source 分离；source 设有 fingerprint/tripwire，候选结束后释放由 Host 执行。
- 模型可见输入必须能从事件和持久化 briefing 重建；压缩使用 `agent.context_compacted` 的 summary 与 retained tail。
- TUI 只投影事件和结果，不伪造未公开的推理过程。

## 实现入口

[ExperimentWorkflow](../../src/application/experiment-workflow.ts) 组合 prepare/run/compare；[Experiment](../../src/application/experiment.ts) 装配候选生命周期。[Runtime 端口](../../src/core/runtime.ts)、[Pack 公共契约](../../src/products/contract.ts) 和 [registry](../../src/products/registry.ts) 定义扩展边界。

外部 Pack 通过 dataDir 的 plugins.json 加载已安装包或编译后模块，校验 API major 与 import/runtime 能力；不下载、不热加载、不运行原始 TypeScript。公开入口是 `@caulif/reprise/pack-api`，history/runtime/projection 三个端口分别负责历史、运行和用户可见投影。应用层不按产品名分支，新增 Runtime 能力先改核心端口再改 Pack。

模型执行复用 [AgentHost](../../src/infrastructure/agent/host.ts)，Session 可跨多次 Invocation 连续使用；同一 Session 不并发请求，关闭或取消后不能继续使用。角色之间不共享业务会话，模型与工具输入必须经事件审计。详细失败语义见[执行](./execution.md)、[恢复](./recovery.md)和[证据](./evidence-and-comparison.md)。

## 默认运行政策

<!-- BEGIN GENERATED default-run-policy (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
| 字段 | 默认值 |
|---|---|
| `wallClockMs` | 86400000（24 小时） |
| `maxTargetTurns` | 256 |
| `maxModelCalls` | 256（仅 Target；journal 无数则不截） |
| `turnTimeoutMs` | 7200000（2 小时） |
| `maxConsecutiveNoProgress` | 2 |

token 与成本上限默认不启用。Controller / Comparison 单次 `timeoutMs` 为 0。
<!-- END GENERATED default-run-policy -->

