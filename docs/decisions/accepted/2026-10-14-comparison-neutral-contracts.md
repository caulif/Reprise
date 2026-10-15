# 决策：Comparison 共享契约与执行策略分离

状态：accepted

## 问题

默认 harness 已使用自主 Comparison Session，但 Context/Port/Result/Facts 及 assertComparisonResult 仍由旧多阶段 executor 模块持有。应用对输出断言的值导入使默认生产路径加载旧 executor、阶段策略和提示词链。type-only 引用本身不会执行旧模块，却让契约所有权继续依附于某个历史实现。

## 决定

将共同类型、证据 allowlist 与输出 schema/当前 catalog 校验原样提取到 agents/comparison-contract.ts。应用、脚本、自主实现及旧 executor 的协作模块直接依赖中立契约。旧模块保留类型与断言 re-export，历史调用方和现有测试可以继续使用原入口。

本批不改变 Port 字段、提示词、输出规范化、allowlist、发布条件、会话生命周期或默认自主策略。默认 harness 和应用编排入口不因共享断言导入旧 executor。历史协议读取与旧 executor 的运行能力继续区分，后续隔离/退役须独立确认使用方与共享 Host 不变量。

## 备选方案

**只改成 type-only 导入**：类型消费者可以避免执行旧模块，但应用需要实际输出校验函数，无法移除两处 runtime 导入，也没有解决契约所有权。

**本批同时删除全部旧测试与 executor**：现有测试混合阶段策略与共享发布、媒体、引用、预览和历史认证，直接删除会丢失行为证据。先移动中立契约，后续单独迁移适用回归和退役执行策略。

## 影响

内部 import 路径更明确，旧类型/断言路径保持兼容。没有 on-disk 或 API 字段迁移，不改变 24 小时预算和真实调用 opt-in。旧多阶段 executor 仍在 src/test 内，不把本批描述成完整退役或恢复强制阶段。

## 验证

通过编译后的子进程阻断 comparison-agent.js 的模块解析，加载默认 harness、workflow、comparison 与报告编排入口，证明实际 runtime import 图不依赖旧 executor；同一个 hook 显式加载旧模块必须失败，作为检测器负控。中立/兼容断言保持同一函数，回归覆盖 schema、未知引用和当前 catalog；既有自主与旧执行测试继续执行。只加载模块和 fake Session，不调用真实模型或 Runtime。

阻断器先归一化相对 specifier，并检查实际解析结果 URL；负控同时执行绝对 URL 与真实相对 import。即使后续退休的 executor 文件不存在，相对导入也必须命中阻断器，不能把普通 module-not-found 误作负控通过。

现行规则见[证据与对照](../../architecture/evidence-and-comparison.md#comparison-attempt)。
