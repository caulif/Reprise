# Controller：看完整会话，自主决定下一句和停止

状态：计划。落地时改 Controller System Prompt（及 snapshot），并同步 [Controller 设计](../architecture/controller.md) §9–10 与实验条件里「完整会话怎么用」的表述。Host 循环、`send`/`done` 信封、开场必须 `send` 保持不变。本文不覆盖当前产品规范。

相关：[同等人类能力](../architecture/controller.md)、[Controller 实验条件](../architecture/controller-experiment-conditions.md)、[Controller 拥有每一轮用户输入](./controller-owns-every-user-turn.md)、后续装配：[Host 与 Controller 协作装配](./host-controller-collaboration.md)。

## 判断

架构已经要求：Controller 看见完整原始会话，等价的是这个人的目标、知识和**验收习惯**，不是历史原文，也不是历史轮次数。Target 仍只收到 Controller 写的用户句。

这一跑里一轮就 `satisfied`，不是因为 Host 少问了一次，而是 prompt 把判定题出歪了：

- 停机第一条用 `baseline.finalMessage` 的**交付物种类**当杆，并对「再发一句」写成禁止的形式上确认。
- 历史后续用户句被写成：**候选问起**才送。看完一版才说的口味、改稿，候选不问就到不了。
- 模型其实在做判断；它判断的是这张检查表，不是「这个人看着当前屏幕还会不会说话」。

不采用「历史有几句用户话就按序投几句」。那会把对照收成剧本：候选走了另一条路时，下一句历史话会对不上屏幕；更好的候选也会被拖去模仿旧轨迹。轮次多少由 Agent 对**这一条候选轨迹**决定，只是它必须先读懂这个人平时怎么协作。

杠杆是 System Prompt（外加 briefing 里把用户句放在够显眼的位置）。不新增 Host 对 `done/satisfied` 的轮次闸门，不校验「是否用完」`historicalUserTurns`。

## 目标行为

每次 steering，Controller 在读过完整会话（至少读过全部用户句）和当前候选可见结果之后，自己选择 `send` 或 `done`。

| 要做 | 不要做 |
|---|---|
| 用户句是协作与验收的主证据：第一版之后他们通常还说什么、多严、何时才真的收工 | 按历史下标重放 U1、U2、U3 |
| 对**当前**产物说这个人会说的话；历史后续句是偏好和习惯，不是队列 | 等候选先问，才把用户已经说过的偏好送出去 |
| 种类已经像终态句（「有一份 PPT HTML」）仍可能 `send/correct` 或 `send/verify` | 种类对齐就立刻 `satisfied` |
| 候选已经做到或超过这个人会接受的程度 → `done/satisfied`，即使比历史更短 | 为了凑历史轮次再发空确认 |
| 历史助手的实现、调查结论不当作用户已知 | 把原 Agent 的做法写成用户提示 |

开场规则不变：尚无候选回合，只许 `send`。预算、墙钟、重复 `send` 仍由 Host 执行。

## Prompt 要改的部分

保留：角色、opening、不泄漏实验、不替候选干活、高影响授权、`blocked`。

改写 `# Inputs` 里对 `historicalUserTurns` 的句子，以及整个 `# Deciding`。

目标稿（实现时写入 `CONTROLLER_SYSTEM_PROMPT`，可调措辞，不改信封）：

```text
# Reading the historical session
The full transcript is evidence of this person, not a script and not a solution key.
Read the user messages with care: they show goals, constraints, taste, how they
correct a first draft, and when they actually stop. Assistant and tool turns show
what happened then; do not copy that path, and do not treat the historical agent's
discoveries or implementations as facts this user already knew.

historicalUserTurns lists later user utterances in order. Use them as knowledge and
habit. Do not fire them in sequence regardless of what the candidate just did.
If a stated preference or correction still applies to the current artifacts, say it
in this user's voice. If the candidate already satisfied that point, do not repeat it.
Do not wait for the candidate to ask before using a preference the user already stated.

# Deciding
After a candidate turn has settled, decide as this user looking at the current screen:

1. Would this user, given their demonstrated acceptance habits — not merely the kind
   of deliverable named in baseline.finalMessage — actually stop here?
   A first-pass artifact that only matches the type of the accepted result is not
   satisfied if this user historically kept steering after the first deliverable
   (taste, structure, missing pages, verification). Completion claims are not evidence.
   If the candidate's result meets or exceeds what this user accepted, including
   those habits, return done/satisfied. Do not send a message only to pad turn count.
   A shallower result than that bar: send/verify or send/correct.
2. Authority the historical user never granted → done/requires_real_user_decision.
3. Stuck in a way no ordinary user message can fix → done/blocked.
   One failed command or a clarifying question is not blocked: send the reply.
4. Real deviation from goal, scope, or stated preferences → send/correct.
   A different valid path is not deviation.
5. Missing a fact this user already knew → send/inform.
6. A completion claim or risky step needs a check this user would demand → send/verify.
7. Otherwise: if this user would still speak, send/continue with what they would
   say to THIS trajectory; if not, done/no_further_value.
```

删掉现行第 1 条里的「立刻 satisfied / 不要为形式上再确认而发一句」——它把续聊标成违规。用「不要为凑轮次而发」代替，方向相反。

## Briefing（辅助，不是闸门）

Agent 已能 `read_observation` 整段 transcript。为降低「没翻用户句就停」：

- `SteeringContext` 里 `historicalUserTurns` 保持全文（已有）；prompt 要求 steering 时先按这些句理解验收习惯，必要时再 `read` 产物。
- Host 的 `current.summary` 不要把候选终态自述放在最前当主信号；结算状态、改过的路径、命令次数即可，正文留给工具。
- 可选：Host 投影一条不可伪造的计数，例如用户后续句条数，仍不规定必须 `send` 几次。

不在 Host 拒绝 `done`。漏看会话是 Controller 质量问题，用 prompt 和评测夹具抓，不当成协议错误。

## 落地顺序

1. 改 prompt 与 snapshot；更新 `controller.md` 推荐思考顺序，使「验收习惯」先于「终态句种类」。
2. 缩短或改写 `current.summary` 的可见终态句。
3. 夹具：历史有多轮用户改稿、候选第一枪只交出同种类产物时，不得在测试里断言必须 `done`；应用含用户后续句的 briefing 跑决策（可用固定假模型）断言倾向 `send`。不断言发出历史原文。
4. 写 accepted 决策：停止条件是「这个人面对当前轨迹会停」，不是种类匹配，也不是用完历史用户句。

## 不做

- 不按序强制投递全部历史用户句。
- 不把「send 次数 ≈ 历史用户句数」做成门禁。
- 不恢复 Host 投递冻结 `initialInput` 原文。
- 不让 Controller 执行目标任务或给候选喂历史助手的实现。
