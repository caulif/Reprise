# 决策：Recovery ready 必须交出任务前 HEAD

状态：accepted
日期：2026-09-16

## 问题

N6 的 Git sink `initial` 等于历史会话自己的 SEO 提交。Recovery 把当时活 cwd 的 HEAD 与任务之后的脏文件交给候选，信封仍可 `ready`。[最小 Host](../../plan/recovery-agent-minimum-host.md) 禁止 Host 预先 checkout 并宣布恢复完成，但不能把「必须交出 `initialInput` 之前的任务条件」也一并放弃。

## 决定

`ready` 必须能回答：工作副本 HEAD 是否为**任务开始前**的提交。解析顺序：

1. Case 上的 `taskContext.historicalCommit`，若它与历史事件里记录的任务提交不是同一对象，则视为任务前 SHA；
2. 否则取历史事件中第一笔能在工作副本里验证的任务相关 commit 的父提交。

若 HEAD 等于该历史任务提交，或该提交已是 HEAD 的祖先，Host **拒绝**把这次恢复标为可发布的 `ready`：不自动 accept，不把 `runnable` 设为 `isolated`，并把不对等写入 Run 诊断（`recovery.warning` 与 `recovery-pre-task.json`）。Agent 信封正文不改写；模型仍可输出 `ready`，Host 机械门关闭 Candidate 启动。

脏工作区里、mtime 晚于历史会话结束时间的未提交路径默认不得留在候选可见树。`node_modules`、`.venv`、`vendor`、`target` 等运行依赖目录除外。Host 只报告路径事实并拒绝 `ready`，不替 Agent 选择保留或删除哪些任务文件，也不预先 checkout。

Agent 信封仍只有 `ready` / `blocked`。不重新引入 `partial` 作为放行条件。

## 备选方案

**信封显式 `partial` 且 Host 写入诊断后仍发布。** 能保留「起点不对等但继续跑」的实验，但会把污染树送进 Git sink 与 Comparison。本批选择拒绝 `ready`。

**Host 自行 checkout 任务前 SHA 并宣布恢复完成。** 替 Agent 选了内容，与最小 Host 冲突。

**只改 Comparison 文案。** 下一轮复刻仍从历史成果起步。

## 影响

替代 [最小 Host](../../plan/recovery-agent-minimum-host.md) 与 [单工作副本循环](./2026-09-09-recovery-single-workspace-agent-loop.md) 中「Host 绝不预先 checkout / 不否决 ready」在**任务前 HEAD 与任务后脏树**上的范围：Host 仍不替 Agent 选内容、不把 checkout 当作恢复结论，但可以拒绝「HEAD 已含历史成果」的 `ready`。source tripwire、报告、预算等既有机械门不变。Codex 冻结探测与 Comparison HTML 不在本决定范围。

## 验证

`test/application/recovery-pre-task.test.ts`：HEAD 等于历史任务提交时 `readyAllowed` 为假且 `recoverExperiment` 不自动 accept；HEAD 为父提交且工作区干净时允许；任务后脏文件挡住 `ready`，`node_modules` 不挡。反向：HEAD 已等于历史任务提交仍发布 `ready` 基线则红。
