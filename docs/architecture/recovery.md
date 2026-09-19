# Recovery 与隔离

Recovery 的目标是给历史任务找到一个可执行的起点，不宣称恢复了所有过去状态。它在候选运行前完成，使用一个可写工作副本、只读 source 挂载、只读 observations 和产品 playbook。

## 来源、staging 与 checkpoint

`LocalWorkspaceProvider` 先读取并 fingerprint source，不修改 source。复制受文件数量、总字节、单文件和排除规则约束；超预算时保存 summary 和 excluded entries，staging 的 seed 可以是 `copied`、`sparse` 或 `checkpoint`。完整复制成功后可捕获 provider-owned checkpoint；checkpoint 元数据和 fingerprint 经过 schema 校验。

当前实现会优先复用 source/checkpoint，并按预算建立 staging；“默认空 staging”仍是开放目标，不能写成现状。source 在准备前后有 tripwire，变化会使恢复验证失败。外部服务、远程副作用和未观察到的环境状态不会因本地副本而被宣称已还原。

## Recovery Agent 三轮

一个 Recovery attempt 使用一个 Session 和同一工作副本，三个主要轮次。Recovery Agent 自己按提示词在每轮结束前写 `.reprise/recovery-work/notes.md`；Host 保存并在继续同一 Session 时重新提供该位置：

1. **understand**：读取完整任务输入、playbook、历史索引和工作区摘要，确定起点边界与关键未知。
2. **restore**：在工作副本内调查、复制、清理、重建配置/依赖并运行有界检查；保持原任务未完成。
3. **conclude**：再次检查，写工作副本根部的 `recovery.md`，区分观察、推断、已执行动作和未解决项，返回 `ready` 或 `blocked`。

Host 的机械检查报告缺失文件、越界写入、source tripwire、schema 和报告格式问题；Recovery 编排在后续调用中把这些结果作为 `mechanicalFeedback` 传回 Agent。机械反馈和结构化修复可能增加模型请求，不能把三个主要轮次当成最多三次模型调用。有效结论缺少 recovery.md 时，Host 会根据 summary/unresolved 生成最小报告；报告缺失本身不必推翻结论。Agent 的一行 summary 原样进入 baseline 事实，Host 不另造证据评分。

`ready` 表示存在合理的可执行起点，非关键未知可以保留；`blocked` 表示继续需要猜测关键输入、任务条件或结果边界，且必须带 unresolved。Recovery 失败、取消、超时和无效输出都有 failure stage，但不应伪造为成功恢复。

## 隔离边界

Recovery 工具以工作副本为 cwd，受控文件写入限制在该根内。source/、observations/、playbook 只读；Host 通过路径边界、source 写锁和 fingerprint 保护 source。候选运行随后从接受的 baseline 准备独立副本，Runtime 启动上下文声明 `workspace: isolated`。Git sink、捕获 artifacts 和 cleanup 都归 Harness 管理。

本机 shell 隔离不是全局容器沙箱；凭据目录、全局配置和外部系统不在恢复能力内。Windows 11 是已验证平台，Recovery 工具自己的 shell 发现链不能与通用 Runtime spawn 规则混为一谈。

## 接受与 Git 安全

[收尾流程](../../src/application/recovery/run-finalize.ts) 先验证 Provider 结果，再执行任务前 HEAD 检查；只有 ready 且未被该机械闸门阻挡才自动接受。blocked 保留为缺关键输入，任务前检查失败为 blocked_by_safety，二者不能混同。路径存在或测试通过不证明历史起点等价。

Git remote 在 Harness 拥有的树内改写至本实验 sink，禁止为补齐对象触发 lazy fetch；对象不完整也不能跳过 remote 保护。sink 的 initial refs 来自所观察的工作树，sink 隔离不代表其中内容已经是任务前状态。树内链接只按已验证边界处理，越界或无法解析的链接不跟随。NTFS 写锁和 source fingerprint 是保护与检测手段，不是对任意 shell 外部副作用的完整撤销机制。

[LocalWorkspaceProvider](../../src/environment/local-workspace-provider.ts) 拥有 staging、checkpoint、accept 与副本生命周期；[Recovery Agent](../../src/agents/recovery-agent.ts) 拥有调查和结论；[编排](../../src/application/recovery/orchestrator.ts) 拥有 created → staged → forensics → model → validated → accepted/failed 生命周期。具体 Git 不变量见[隔离决策](../decisions/accepted/2026-09-11-git-isolation-invariants.md)。
