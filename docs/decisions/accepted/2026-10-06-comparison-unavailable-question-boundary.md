# 决策：未结案的关键问题约束短报告结论

状态：accepted

## 问题

发现记录中的决策问题可以因证据或调查截止而标记 unavailable。该状态允许停止调查，却不意味着相关任务关系已确认。原草稿约束只检查 observation 的支持范围；即使观察本身完整，未结案的另一个重要问题仍可能改变选择。

## 决定

声明 decisionBasis、conclusionScope 或 findingDispositions 的新草稿，只要当前 findings 有 unavailable 决策问题，就不能声明 supported_in_scope，且必须提供非空 decisionBoundary。拒绝反馈保留实际问题 ID、question、decisionImpact 与 resolution，让作者说明该未知如何限制本次选择。conditional 与 undetermined 是合法结果。

该检查不解决问题、不改写来源或记录、不认证自然语言真假，也不将截止原因当成证据不存在。决定性未知的正确含义与主文是否矛盾仍由实际独立审阅确认。原旧类型化草稿省略这些字段时保留兼容行为。

## 备选方案

**只依赖重要限制数组。** unavailable 问题不必重复出现在该数组中，漏掉数组不能解除关键问题。

**自动复制全部问题到正文。** 容易重复已有短边界并超过原篇幅预算；由模型针对实际选择解释其影响，原完整问题继续保留用于复核。

## 影响

停止调查与任务判断分离；有条件选择和无法判断可以收尾，但不能以 ready 状态支持完整保证。不增加字段、预算或模型参数，不修改已有发布、正式检查和预览绑定。

## 验证

完整的双侧输出 observation 与空 importantLimitations 下，unavailable 问题仍拒绝无条件范围和空主边界。逆例同时验证合法 conditional、问题原文不变、resolved 解除此约束以及 legacy 兼容。先 build 后运行对应定向测试与完整门禁。
