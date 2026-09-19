# 决策：开场不得引用未发生的候选建议

状态：accepted
日期：2026-09-16

## 问题

Controller 写出候选收到的每一句，包括第一句，但不重放 `initialInput`。历史后续用户句常接在「原 Agent 已给出建议清单」之后。若把那种口吻当成开场，候选 0 轮可见文本时就会收到「按你建议的优先级」——这是答案泄漏，不是同等人类能力。

## 决定

- Prompt：opening 的任务形状必须与 `initialInput` 同类（样本：先分析、先不改）。不得引用候选建议、优先级或清单，除非本回合候选已经写出对应可见文本。Host 不要求逐字重放。
- Host 浅层失败：opening（可见轮次为 0）且 `send.message` 匹配 `按你（上次）建议` / `你建议的优先级` / 英语 `follow|per your (last|previous) suggest` 时，校验失败并走现有 structured repair。修复合规后投递；耗尽则 opening 失败，不把泄漏句交给 Target。
- steering 在候选已有可见回合后，允许引用该回合里实际出现的建议。

## 备选方案

**只改 prompt，Host 静默放行。** 无法挡住 N6 这类开场；门禁也验不到。

**记诊断并允许实验继续。** 泄漏句仍进入候选，复刻仍不公平。

**Host 强制逐字投递 `initialInput`。** 与「Controller 写出每一条用户输入」冲突，且会把历史绝对路径交给候选。

## 影响

[实验条件](../../architecture/execution.md#controller-时机与权限) 第 6 条。不改 Comparison 卡面，不改 Recovery 信封。浅层正则不是全程泄漏评分。

## 验证

`test/application/controller-opening.test.ts`：候选 0 轮时第一句含「你建议的优先级」则 `decide` 失败；同句在 steering 且已有回合时通过。opening prompt 与 system prompt 快照含任务形状与「不得引用未写出的建议」。`npm run check` 必须通过。
