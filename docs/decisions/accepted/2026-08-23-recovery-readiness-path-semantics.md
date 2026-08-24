# 决策：Recovery readiness 路径语义

状态：accepted

## 问题

`historicalBehavior.touchedPaths` 只说明历史任务曾经访问或写入过路径，不能单独证明这些路径在任务开始时就是必需输入。对于“下载并整理”“生成报告”等输出型任务，Recovery 的目标是把隔离工作区回退到任务开始前；历史任务产生的文件缺失可能正是正确的起点。如果把所有 touched paths 都当作 required inputs，Agent 删除历史产物后会被 readiness 错误阻塞。

## 决定

Recovery readiness context 增加可选的 `pathSemantics`：

- `required_inputs`：相关路径是继续任务所需输入；路径不存在或为空时返回 `not_ready`。
- `task_outputs`：相关路径是历史任务可能产生的输出；恢复到任务开始状态时，路径不存在不阻塞 readiness。若输出仍存在，仍只在 staging 中检查其边界和可读性，不把它当作输入内容物化。

当前由 Host 根据脱敏任务文本采用保守的输出型任务启发式推导该字段。明确的下载、整理、创建、生成、导出等输出动作可使用 `task_outputs`；普通的继续编辑或读取任务保持 `required_inputs`。后续若历史证据能直接区分输入与输出，应优先改为显式 Host evidence，而不是继续扩大正则。

缺少所有 relevant paths 仍然不是 readiness 成功；任务必须至少有一个可检查的任务相关路径或后续专门的 readiness check。`task_outputs` 不会复制 source、创建内容或访问 staging 外路径。路径仍执行 staging 边界校验；命令仍默认不执行，显式执行时仍受既有 allowlist 和进程边界限制。该字段是 Host-derived 的模型可见约束，必须经过 `RecoveryReadinessContextSchema` 校验并记录在现有 readiness 事件中。

## 备选方案

**把所有 touched paths 都当作 required inputs。** 输出型任务在删除历史产物后会被 readiness 永久阻塞，与“回到任务开始前”冲突。

**为每条路径要求人工标注输入/输出。** 会话导入无法得到标注，默认路径会停在人工闸门，无法自动评估。

## 影响

- 输出型任务可以在历史产物缺失时继续 readiness。
- 输入型任务缺失路径仍为 `not_ready`。
- Host 启发式可能把边界任务标成 `task_outputs`；错误时宁可少阻塞、靠后续证据纠正，而不是把输出当输入。

## 验证

反向测试覆盖输出型任务缺少历史产物时可 ready，以及输入型任务缺失路径时仍为 `not_ready`。真实 Claude recovery case 将验证该语义是否能让反馈驱动循环继续到 `ready_for_task`，同时检查 source digest、staging 隔离和终态事实链。
