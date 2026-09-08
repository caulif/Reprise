# 决策：experiment.ts Controller 编排拆分过渡

状态：accepted

## 问题

当前 `experiment.ts` 同时承载 CandidateRun 与 Controller 编排，超过源码体积门禁的常规边界。

## 决定

`experiment.ts` 将 CandidateRun 与 Controller `decide` 循环放在同一 application 模块。文件长度遵守源码体积门禁，不登记例外。

## 备选方案

**通过放宽源码体积门禁永久保留实现。** 这会掩盖明确的编排边界，不接受。

## 影响

该记录不改变运行时行为。Session-first 重构实施时应重新评估文件所有权，而不是机械保留当前拆分目标。

## 验证

源码尺寸门禁对 `experiment.ts` 无例外；`npm run check` 必须通过。
