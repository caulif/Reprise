# 决策：experiment.ts Controller 编排拆分过渡

状态：accepted

## 问题

当前 `experiment.ts` 同时承载 CandidateRun 与 Controller 编排，超过源码体积门禁的常规边界。

## 决定

在当前实现中，Controller 完成护栏暂时与 CandidateRun 编排共存于 `experiment.ts`。文件拥有到 2026-10-01 的短期门禁例外；后续将 Controller turn loop 提取到独立 application 模块并删除例外。

## 备选方案

**通过放宽源码体积门禁永久保留实现。** 这会掩盖明确的编排边界，不接受。

## 影响

该记录不改变运行时行为。Session-first 重构实施时应重新评估文件所有权，而不是机械保留当前拆分目标。

## 验证

源码尺寸门禁验证例外有效期；提取完成时删除例外并运行 `npm run check`。
