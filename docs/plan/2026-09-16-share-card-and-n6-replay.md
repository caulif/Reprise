# N6 Recovery + Controller 复刻验收

OPEN：缺少新 N6 Recovery+Controller 显式 opt-in 重跑的完整通过证据。离线检查通过、卡面出图或旧实验报告都不能关闭复刻公平性验收；本批只修文档，不运行真实模型或 Runtime。

## 验收范围

以 N6 历史任务「先分析 blog SEO、先不修改」为起点，授权后新跑 Recovery 与 Controller，保留以下可复核证据：

- 任务前 baseline：核对嵌套仓发现、任务前 HEAD 与候选可见树；不得包含历史任务提交或任务后的脏文件（运行依赖按既有规则处理）。HEAD 来源、拒绝发布条件遵循[任务前 HEAD 决策](../decisions/archive/accepted-2026-09/2026-09-16-recovery-pre-task-head.md)与[嵌套 Git 发现](../decisions/accepted/2026-09-16-freeze-nested-git-discovery.md)。恢复失败或被阻挡是有效失败证据，不算公平复刻通过。
- 开场：从本次事件与用户输入核对，候选尚无可见建议时，第一句仍是先分析、先不改，不得引用未发生的建议、优先级或清单；以[开场约束](../decisions/accepted/2026-09-16-controller-opening-no-unseen-advice.md)和[实验条件](../architecture/controller.md#4-实验条件)为准，不要求逐字重放。
- 新运行证据：记录本次运行标识、模型、授权范围、baseline 与 Git sink initial、实际 opening 及结果。两项条件须在同一次新复刻中成立；失败或缺证据时保持 OPEN，并记录缺口。

## 不可替代的证据

旧 N6 sink initial 已含历史 SEO 提交 `294c695`，旧 opening 引用了候选尚未给出的优先级。不得复用该 sink 或旧 MiniMax 候选轨迹充当新复刻，不重写它们来宣称候选未见历史成果；旧报告重渲染也不是新 Recovery+Controller 验收。

真实调用须操作者明确授权并显式 opt-in，不进入默认门禁。平台、Controller 能力 lane 与 provider 输入对拍另见[证据矩阵](./2026-09-08-platform-evidence-matrix.md)；本项结果入口见 [MASTER](../progress/MASTER.md#未关闭验收)。
