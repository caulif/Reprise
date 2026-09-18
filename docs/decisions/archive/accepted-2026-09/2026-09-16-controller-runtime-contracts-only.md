# 决策：Controller 运行时只保留合同校验

状态：accepted
日期：2026-09-16

## 问题

`validateControllerDecision` 用措辞正则拒绝 `INDEX.md` / `briefingRoot` 等 Host 词，以及 opening 的「按你建议的优先级」。这些模式既拦不住换一种说法的泄漏，又把合法用户口吻送进修复轮。合同类失败（长度、控制字符、schema、evidenceRefs 归属、opening 必须 send）与措辞混在同一条路径里。

## 决定

运行时拒绝只留可精确定义的合同：

- 信封 schema
- `evidenceRefs` 必须属于本 turn 的 Host catalog
- opening 不得 `done`，必须 `send`
- `send.message` 非空白、不超过 65536 字节、不含 DISALLOWED_CONTROL 控制字符

删除 `HOST_TERMS_IN_MESSAGE` 与 `OPENING_UNSEEN_CANDIDATE_ADVICE` 及其导出函数。命中原禁词或「按你建议」不再触发 structured repair。System prompt 与 opening 委托仍禁止泄漏 Host 术语、仍禁止引用候选尚未写出的建议；默认不新增运行时正则作补丁。离线观察或评测可以另做，不进入 `decide()`。

替代 [开场不得引用未发生的候选建议](../../accepted/2026-09-16-controller-opening-no-unseen-advice.md) 中「Host 浅层失败并走 structured repair」的条款；该决定的 prompt 约束仍有效。

## 备选方案

**保留措辞正则。** 换一种说法即绕过，且把 INDEX.md 这类文件名当成非法用户句。

**把正则改成更宽的泄漏评分。** 无法精确定义，误伤真实用户口吻，且与「第一版不做全程泄漏评分」冲突。

**opening 强制逐字投递 initialInput。** 与 Controller 写出每一句冲突。

## 影响

[`controller-agent.ts`](../../../../src/agents/controller-agent.ts)、[实验条件](../../../architecture/controller.md#4-实验条件) 第 6 条。不改 Comparison 发布，不改 Recovery 模型轮次。

## 验证

`test/application/controller-runtime-contracts.test.ts`：`INDEX.md` 与「按你建议的优先级」opening send 成功；opening `done`、空白消息、控制字符、未知 evidenceRef、超长消息仍失败。`test/application/controller-opening.test.ts` 同步改为措辞不再拒。`npm run check` 必须通过。反向：措辞再触发修复轮则红；合同失败被放行则红。
