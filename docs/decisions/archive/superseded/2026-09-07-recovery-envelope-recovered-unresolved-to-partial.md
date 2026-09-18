# 决策：Recovery 信封 recovered 带 unresolved 时收成 partial

状态：superseded

被 [单工作副本自主三轮循环](../accepted/2026-09-09-recovery-single-workspace-agent-loop.md) 取代。下文冻结。

状态：superseded
日期：2026-09-07

## 问题

TypeBox 合同要求 `recovered` 的 `unresolved` 为空，`partial` 才带未决项。系统提示却写「把不确定写进 unresolved」，输出契约只用三个 JSON 样例暗示配对。模型按提示填了未决又自称 `recovered`，Host 在 schema 上整单 `invalid_output`，即使工作区回退已经做完。

## 决定

`recovered` 仍表示无未决项。解析后、TypeBox Clean/Check 前，若 `status` 为 `recovered` 且 `unresolved` 是非空字符串数组，Host 把它改成 `partial`，其余字段不动。空 `unresolved` 的 `recovered` 不改。提示词与修复句写明：有 unresolved 就必须 `partial`。不放宽 Provider 对 `recovered` 的路径级强证据要求。

## 备选方案

**只改提示、schema 仍直接拒绝。** MiniMax 已在一次修复后仍交 `recovered`+未决；提示打架时单靠样例不够。

**放宽 schema 允许 recovered 带 unresolved。** 状态名与强证据合同失去对应。

**在 repair 轮用自然语言解释错误。** 仍消耗一次模型调用，且本次修复提示没有点出配对规则。

## 影响

带未决项的回退会进入 `partial` 预览，而不是确认页上的协议失败。模型仍可能把 JSON 夹在散文里；那是另一条「最后一条只能是 JSON」的规则，本决定不处理。

## 验证

`test/recovery-envelope.test.ts`：`recovered` 加非空 unresolved 完成且值为 `partial`。反向：`recovered` 且 `unresolved: []` 保持 `recovered`。
