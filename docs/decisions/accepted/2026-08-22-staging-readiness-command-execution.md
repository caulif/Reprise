# 决策：任务就绪命令只能在 staging 中显式回放

状态：accepted

## 问题

Recovery readiness 以前只检查路径，历史命令仅作为模型提示，无法证明恢复后的 staging 能执行原任务的最小继续动作。直接执行历史 shell 字符串又会引入 source 越界、注入和外部副作用风险。

## 决定

增加 Host-owned 的 staging readiness command check，但默认不执行。调用方必须显式传入 `executeReadinessCommands: true`；命令经过固定可执行文件白名单、控制字符检查和 `-e`/`-c`/路径穿越拒绝后，以非 shell 子进程在恢复候选目录作为 cwd 执行。输出只保存摘要 digest 和退出类别，不保存原始 stdout/stderr。

命令失败或被拒绝会使 readiness 保持 `not_ready`，并通过 `recovery.readiness_checked` 事件把结构化检查结果反馈给后续 Recovery 轮次。路径缺失时不执行命令，避免在输入不完整的 staging 上产生副作用。

## 影响

- 默认 Recovery 路径不产生额外进程或网络费用。
- 真实评估只有设置 `REPRISE_RUN_RECOVERY_CONTINUATION_CHECKS=1` 时才启用该能力。
- 该能力不是通用 shell 工具；需要新的命令类型时必须单独评估白名单和边界。

## 验证

- `test/recovery-readiness.test.ts` 验证默认不执行命令、允许的 `node -p` 在 staging 执行，以及 `node -e` 被拒绝。
- `npm run build` 和受影响的 readiness 测试通过。
