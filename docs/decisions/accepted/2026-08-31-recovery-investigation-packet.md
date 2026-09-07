# 决策：Recovery 调查包是进入模型的 Host 事实

状态：accepted

## 问题

把冻结 transcript 的翻页交给模型当调查主通道，既撑爆上下文，也让路径线索停留在 162 轮原文里。Host 已经持有 catalog、preimage、relevantPaths 和后续用户句。

## 决定

调用 Recovery 模型前，Host 从 TaskCase 与 `resolvedRecoveryFacts` 生成有界调查包：后续用户句、去重后的相对路径线索、preimage/patch 路径摘要、`isRepo`。包有硬上限；超限截断并标记 `truncated`，不得把全文 transcript 塞进包。整包进入 `RecoveryContext` 并写入 `recovery.model_input` artifact；另记 `recovery.investigation_packet` 事件（条数、digest、truncated），以便从事件日志复原「模型看见了哪些 Host 线索」。`derive_task_footprint` / `search_recovery_artifacts` 的路径抽取并进该生成函数，不再作为工具。

## 备选方案

**继续让模型用 `read_observation` 自己翻。** 走查已证明主通道失败。

**第一轮塞进全文 transcript。** 曾经撑爆上下文。

## 影响

Prompt 要求先读调查包再对照 staging。缺句时读 `observations/` 文件，不再分页翻冻结历史，见 [工作集与观察文件](./2026-09-07-recovery-working-set-and-observation-files.md)。

## 验证

`test/recovery-investigation-packet.test.ts`：夹具含任务句与 `foo.html` 时包内出现该路径；超限截断且 `truncated=true`。编排测试断言存在 `recovery.investigation_packet` 事件。
