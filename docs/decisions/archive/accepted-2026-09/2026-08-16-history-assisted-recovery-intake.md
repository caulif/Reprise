# 决策：历史索引会话走统一恢复入口

状态：accepted

## 背景

部分 Claude Code 历史只有 `history.jsonl` 索引而没有完整 project transcript。把它们直接丢弃会损失仍可由任务输入、Git 与工作区证据恢复的实验入口；把它们伪造成完整历史回放又会夸大证据。

## 决定

所有可导入会话统一经过 `inspect → freeze → recovery → run`。产品契约以 `evidenceLevel = transcript | history` 表达证据来源：完整 transcript 优先，history 仅提供最小任务线索。该字段随 `TaskCase` 持久化并传递给 Recovery Agent；它影响 Agent 的证据表述与调查策略，但不成为 TUI 的模式选择。

history-only 导入不得制造 assistant 回复、工具调用、历史 final message、补丁、提交或 baseline evidence。Recovery Agent 可以依据隔离 staging、Git、文件和初始任务进行恢复，必须把推断和未解决项写入 `recovery.md`。真实 Candidate Run 的费用/外部调用确认仍是唯一用户确认边界。

## 后果

- Product Pack 必须能区分但不向用户流程暴露证据来源；完整 transcript 与 history 的同 sessionId 去重时完整 transcript 胜出。
- `TaskCase` on-disk schema 发生版本兼容性扩展，旧记录缺字段时按 `transcript` 解释。
- 报告与比较不得把 history-assisted 运行描述为已验证的历史逐步回放。
- 没有可用初始任务文本的 history 条目仍不可导入，并以安全聚合诊断报告。

## 验证

由 `test/claude-code-pack.test.ts`、freeze/schema 回归、Recovery Agent context 测试、TUI intake 测试和 `npm run check` 覆盖。
