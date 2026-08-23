# 决策：Recovery 评估 artifact 与逐样本终态

状态：accepted

## 问题

历史完成会话和 checkpoint 中断样本的评估数据必须分层，且真实批次中的单条故障不能使后续样本或结果归档丢失。此前 artifact 只保存 v1 测量行，缺少可在进程异常后审计的 started、terminal 与 source audit 记录。

## 决定

`RecoveryEvaluationCaseSchema` 保留 schemaVersion 1 的历史测量行，并新增 schemaVersion 2 的终态行。v2 行包含互斥 terminal 状态、脱敏 failure code/operation 与 source audit outcome。`runRecoveryEvaluationBatch` 在每个 case 执行前写入 schema-checked started 记录；无论执行或 source audit 成功与否，均写入 schema-checked terminal 和独立 source-audit 记录，再继续下一个 case。文件 sink 使用安全 case id、一次性原子写入，且不保存 cwd、参数、stderr 或原始异常。

## 备选方案

**仅在批次外层捕获异常。** 这无法证明中断发生在哪个 case，也不能保证之前或之后的 case 有终态，因此落选。

**把原始异常或命令输出写进评估 artifact。** 这会把路径、会话内容或凭据邻近数据扩散到报告，且对聚合指标无必要，因此落选。

**破坏性升级所有既有 v1 artifact。** 旧 artifact 是已生成的只读实验输入；保留 v1 读取兼容性比迁移历史受控数据更安全，因此落选。

## 影响

新的真实 batch runner 必须消费 v2 protocol；聚合器继续读取 v1 和 v2 行。终态代码是评估基础设施的安全摘要，不替代 Agent、Provider 与 verifier 更细粒度的失败分类。每个 case 多出三个很小的 JSON 文件，但换来可恢复的批次审计边界。

## 验证

`test/recovery-evaluation.test.ts` 注入 case 与 source-audit 故障，验证十条 case 均有 started、source audit 和 terminal，后续 case 继续执行，且终态不含原始异常文本。`npm run check` 验证 schema、构建、测试和文档门禁。
