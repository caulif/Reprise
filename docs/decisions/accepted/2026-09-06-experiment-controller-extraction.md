# experiment.ts Controller 编排拆分过渡

Controller 完成证据护栏暂时与 CandidateRun 编排共存于 `experiment.ts`。源码体积门禁为该文件登记短期例外，截止 2026-10-01；后续应将 Controller turn loop 提取到独立 application 模块，删除例外。该登记只记录重构边界，不改变运行时行为。
