# 决策：Controller 连续 Session 先理解再按视图决策

状态：accepted

取代 [首次 Invocation 同时完成理解与 opening](../superseded/2026-09-08-controller-opening-single-session.md) 中「同一请求既调查又返回 send」的编排。无账本、实验入口只 `decide`、每 run 一个 Session、Host 不因未读文件拒绝 `done` 仍有效。独立 Understanding JSON 与完成护栏仍见已冻结记录。

## 问题

把历史通读和 opening `send` 压进同一次结构化请求，会迫使模型在尚未形成任务理解时交信封。把用户可见表面拆散进 INDEX 与 turn 文件，也会让 Controller 先钻进事件而不是先看用户当时能看见的内容。权限若只写在 prompt 里，容易被当成可协商的授权。

## 决定

- 每个 CandidateRun 使用一个连续 Controller Session。实验入口只调用 `decide`。
- 首次 `decide` 先发一轮无 schema 的工作委托：按 `history/user-inputs/INDEX.tsv` 顺序读取全部历史用户输入并形成任务理解；不返回决策 JSON，不向候选发送消息。然后在同一 `decide` 内发送 opening 结构化请求，只许 `send`。
- 后续 `decide` 仅在候选 turn 稳定完成后发生，返回一条自然用户消息或 `done`。候选自称完成不是充分结束条件。
- Host 写入 `view.txt` 作为用户可见视图快照；Controller 先看该快照，再按需读取用户可访问详情。`permissions.txt` 由 Host 按历史会话有效设置固定，Controller 不能扩大权限。
- 不写 `controller.understanding` 账本，不因未读 briefing 或缺失 `understandingDelta` 拒绝 `done`。不增加 Controller 专属总预算。

## 备选方案

**恢复独立 Understanding schema 与账本。** 会重新把程序条件当成任务完成，并插入纠正循环。

**保持单次结构化 opening。** 实现更短，但无法把通读历史从交信封中拆开，也与 Comparison 的自由工作委托不一致。

## 影响

opening 理解轮失败与 opening `send` 失败一样，都在投递候选之前进入终态。结构化轮仍使用既有决策 schema。历史 run 上的 `controller.understanding` 事件可只读展示。权限快照分层与当前视图区间见 [权限快照与当前视图](./2026-09-09-controller-permissions-view-prompt.md)。

## 验证

`test/controller-full-session-judgment.test.ts`：一次 `createSession`；首次 `decide` 两次 append（自由理解后 opening 信封），后续 steering 第三次 append；第一轮不含 Return send。`test/controller-opening.test.ts`：opening 拒绝 `done`。`test/controller-briefing.test.ts`：`history/user-inputs/INDEX.tsv`、`view.txt`、`permissions.txt`。`test/codex-experiment.test.ts`：新 run 无 `controller.understanding`，`done` 不被账本守卫拒绝。`npm run check` 必须通过。
