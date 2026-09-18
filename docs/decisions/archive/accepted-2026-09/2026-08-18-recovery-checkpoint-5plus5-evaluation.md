# 决策：Recovery 5+5 checkpoint 真值评估

状态：accepted

## 问题

历史 completed transcript 没有任务开始时的文件真值，不能测量“恢复是否准确”。在可信 checkpoint 已覆盖全部路径时，继续调用模型既增加费用，也会把确定性恢复重新变成不稳定的文本协议。

## 决定

提供显式 opt-in 的 `npm run evaluate:recovery:checkpoint`。它为 Codex 和 Claude Code 各创建 5 条独立的真实本地文件系统中断 fixture，并在每条中 capture checkpoint、修改 source、调用完整 `recoverCodexExperiment`、接受 baseline 并 fork 一份 candidate-visible workspace。

runner 只输出脱敏 measurement：case ID、产品、checkpoint digest、路径计数、逐字节匹配、baseline fork 匹配、source tripwire、恢复/验证状态和模型调用数。它不保存用户路径、文件内容、会话正文或凭据；临时 workspace 被删除，报告写入 Git 忽略的 `.reprise/`。

完整可信 checkpoint 命中时 Recovery Agent 必须不被调用，`modelCalls` 必须是 0。这验证的是 Host 的确定性恢复，不是弱证据 Agent 能力的基准；后者保留给独立、显式 opt-in 的实验。

## 影响

5+5 是回归与冒烟级样本，而不是 99% 统计结论。报告仍用已有 `evaluateRecoveryCases` 聚合 verified path precision/recall，并保留候选/模型指标为 0 或无分母，避免将 baseline fork 伪装成 Agent 候选接受。

## 验证

设置 `REPRISE_RUN_RECOVERY_CHECKPOINT_EVALUATION=1` 后执行 runner；2026-08-18 的 10 条运行通过，verified path precision/recall 均为 1，模型调用为 0。`npm run check` 继续验证静态门禁与测试。
