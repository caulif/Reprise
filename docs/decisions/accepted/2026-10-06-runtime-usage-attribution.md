# 决策：候选模型指标仅归属 Runtime 用量

状态：accepted

## 问题

同一个 runId 同时承载候选 Runtime、Controller、Recovery 和多次 Comparison 的事件。`inspectRun` 原先将全部事件送入通用 usage 聚合器，再按候选 Runtime 的单一模型价格计算费用。真实重比中，候选 Runtime 未重跑，其指标却累计了此前 420 条 Comparison usage；这会把裁判成本误算为候选模型成本，且重复生成报告继续改变比较依据。

## 决定

- `inspectRun` 在调用现有 `aggregateEventUsage` 前仅保留 `runtime.` 命名空间事件。Runtime journal 的所有权来自事件命名空间，不依赖可缺失、可扩展的 Agent role，也不因 Agent 与 Runtime 同模型而合并。
- 过滤后继续使用原聚合与定价逻辑：Runtime 的多次 delta 相加、无 delta 时采用最后 watermark、缓存包含关系与费用规则保持。没有 Runtime 用量时 token 与费用仍未知，不能用 Harness usage 补齐或写成零。
- 通用 `aggregateEventUsage`、历史原始会话 reader、Comparison 自身资源账本保持各自既有语义；本修复只限定候选单模型指标的输入所有权，不改变事件 Schema、持久化格式或既有事件。`runtimeTargetEvent` 已统一将 Target 原生事件置于 `runtime.` 命名空间，无 Agent role fallback。
- 新检查及新 Comparison facts 从原 Runtime journal 重建指标。已发布的历史报告和已冻结的 attempt facts 不原地改写，不把重新计算的指标冒充原报告数据。Comparison 开销仍由该 attempt 独立资源记录表达。

## 备选方案

**收紧通用聚合器。** 会影响历史原始记录，因此只限定候选指标调用边界。

**按 role 或 model 筛选。** 无法可靠识别缺失 role 的旧 Agent usage，也会把同模型 Harness 请求误归属候选。

## 影响

选择调用边界的命名空间过滤，不增加额外账本或重复校验同进程类型边界。Controller 和 Comparison 经同一个 `inspectRun` 获得一致的候选 token 与价格事实。

## 验证

自动化逆例使用真实 ExperimentStore：在同 run 追加三轮 Comparison、Controller、Recovery 与无 role 的大额不同模型 Agent usage，并重开 Store，候选 token、价格与检查结果必须完全不变；Agent 事件仍完整保留。另覆盖没有 Runtime telemetry 时维持未知、Claude 多 delta/cache read/cache creation、Codex watermark 与 cache-inclusive delta。不以本机原报告重算审计代替编译后测试；源码改后统一 build 与 `npm run check`。
