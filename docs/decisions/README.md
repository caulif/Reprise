# 决策记录

这里记录会长期约束跨模块契约、持久化、权限、工具面、发布边界或工程门禁的取舍。ADR 解释为什么选择某个方案；当前规则以事实层为准：

- [架构总览](../architecture/overview.md) 定义系统边界、所有权与 Pack 关系。
- [执行与结果](../architecture/execution.md) 定义 Controller、CandidateRun、投递和终态。
- [恢复与隔离](../architecture/recovery.md) 定义工作区恢复、副本和机械检查。
- [证据与对照](../architecture/evidence-and-comparison.md) 定义事件、输入重建、封存证据和报告发布。

历史记录保留原文供追溯。`accepted/` 是仍需按需查阅的近期决定；`archive/accepted-2026-09/` 是历史 accepted 冷库，不能据目录名推断其中每条规则仍然有效；`archive/superseded/` 明确已有后继；`proposed/` 尚未成为现行规则。历史正文不改写，顶部状态和后继链接是唯一的整理标记。

新增 ADR 仅用于跨模块协议、on-disk 格式、提示词或工具契约、权限边界、架构边界、工程流程和门禁取舍。小型修复、样式调整和单点重命名不默认新增 ADR。不要维护热集数量或手写全局索引；需要检索时使用 `git grep`，并先读现行事实文档。

详见[本轮读者导向文档整理决策](./accepted/2026-09-19-reader-oriented-documentation.md)。
