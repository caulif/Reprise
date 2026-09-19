# 决策：Recovery decision 与 Host envelope 分离

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted

## 问题

Recovery Agent 只输出 `RecoveryDecision`：`status`、`summary` 和 `unresolved`。`reportPath`、artifact、fingerprint、tripwire、baseline 和 checksum 属于 Host-owned 结果，由 Host 在机械检查和封存阶段生成。

## 决定

复杂任务可能已经完成恢复调查和工作区操作，但模型在最后一步忘记字段名、混入 Markdown 或输出错误路径。让模型同时承担业务判断和 Host 封存协议会把有效恢复误判为整体失败。

## 备选方案

**继续让模型生成完整 Recovery envelope**：未采用，因为复杂任务中格式失败会丢失已经完成的恢复工作。

## 影响

- 新流程不生成 `decision`、`recoveryPath` 或 `evidenceRefs` 等旧字段；
- 旧完整 envelope 仅通过兼容读取处理；
- Host 不能根据任意自然语言猜测 `ready`；
- 机械检查失败与模型决策无效必须分别记录。

## 验证

- RecoveryDecision schema 拒绝 Host-owned 字段；
- Host 在运行编排边界补齐 `reportPath`；
- N3/G10 的最终模型输出不再需要生成 baseline 字段；
- 相关 build、typecheck、测试和完整门禁通过。
