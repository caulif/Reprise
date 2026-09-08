# 决策：角色副作用所有权与路径包含

状态：accepted

目标批次见 [M2.1](../../plan/reprise-refactoring-execution.md#m21-收拢业务所有权)。

## 问题

内部角色共用工作区工具工厂。若用字符串前缀判断目录包含，`C:\work\app` 会把 `C:\work\app2` 当成内部路径。若 Comparison 用 `startsWith("scratch")` 一类前缀，会放行 `scratch-evil/`。把恢复接受、候选投递、报告发布做成跨角色 Verifier，会把业务所有权从 application/harness 抽走。

## 决定

副作用唯一所有者：

- 通用执行只做模型请求和结构化结果。
- 恢复接受、候选投递、报告发布留在 application/harness。不新增跨角色业务 Verifier 接口。
- Recovery 只写恢复副本；Controller `allowWrite` 恒为否，隔离副本只读挂载；Comparison 只写本次 attempt：第一段为 `scratch` 的相对路径、`work/comparison-plan.md`，以及 `report.html`。

路径包含一律用 `pathContainedBy` / `relativeInside`（规范化后再比），不用 `relative().startsWith("..")` 或对未规范化字符串做目录前缀。工作区 `write`/`edit` 在落盘后再 `realpath`，真实目标必须仍在 containment root 内。符号链接祖先在写入前拒绝。

## 备选方案

**统一 Verifier 接口覆盖接受/投递/发布。** 把角色业务检查抽成通用端口，所有权不再跟着功能走。

**继续用 `startsWith(root)` 做包含。** 同盘符前缀的兄弟目录会被误收。

## 影响

Comparison 写策略看路径第一段，不是 `scratch/` 字符串前缀。Controller briefing 不得落在 replica 树内，但可以落在名字以 replica 为前缀的兄弟目录。捕获工作区文本快照时，越界相对路径不读盘。

## 验证

`test/comparison-report.test.ts`：`scratch-evil/` 拒绝，`scratch/` 放行。`test/experiment-inspection.test.ts`：兄弟目录 `app`/`app2` 的越界相对路径不进 text snapshot。`test/controller-briefing.test.ts`：`replica2` 不被视为 `replica` 内部。`test/architecture.test.ts`：Controller 只读、无共享 Verifier、containment 走 `pathContainedBy`。既有隔离与恢复工具测试继续成立。
