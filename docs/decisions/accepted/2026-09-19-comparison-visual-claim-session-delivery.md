# 决策：Comparison `data-claim="visual"` 关联 Session 实际媒体交付

状态：accepted
日期：2026-09-19

## 问题

[`inputCapabilities`](./2026-09-19-harness-model-input-capabilities.md) 已保证 text-only 会话不向模型发送原生 image block，但发布侧仍只检查 catalog `available`。文本模型可以把注册图片写进报告给人看，却仍能对未交付给 Session 的媒体打上 `data-claim="visual"`，把“人看得见”说成“模型看过”。

## 决定

1. `verifyAndRenderComparisonReport` 接受可选 `deliveredImageContentHashes`（含空集）。传入时，`data-claim="visual"` 除可解析且 `available` 的 `data-media-ref` 外，还要求对应媒体的 `contentHash` 出现在本 Comparison Session 已交付的原生图片集合中。
2. 裸 `<img data-media-ref>`（无人声称视觉观察）不要求 Session 交付；text-only 路径可照常改写 `src` 并内容寻址发布字节。
3. Comparison 审计 sink 从本 Session 的 `agent.message_appended.images` 与仍含 image 的 `agent.tool_completed` body 收集 contentHash；text-only 剥离后集合为空。
4. 原生 image 的 `contentHash` 改为对 **解码后字节** 取 sha256，与 Comparison media `contentHash` 同一口径，便于关联。
5. Briefing/seed 路径 `materializeComparisonMedia` 在物化成功文件时写入 `contentHash`（及 `byteLength`），使生产侧始终传入的 delivery Set 能与 catalog media 正向绑定。

## 备选方案

**只靠 Prompt 禁止 visual claim。** 发布门禁仍 fail-open；拒绝。

**仅用“Session 是否收到过任意图片”布尔。** 无法把声明绑到具体媒体；C2 更难接；拒绝作唯一规则。

## 影响

- 关闭 B5 ADR 中「`data-claim="visual"` 与报告发布仍依赖后续包」的缺口。
- 事实层：[证据与对照](../../architecture/evidence-and-comparison.md)。
- 验收样例 C1：text-only 可发布真实图片给人看，不发送 image block，不称自己看过。

## 验证

`test/application/comparison-c1-text-only-media.test.ts`：text-only 剥离 + 无 claim 发布字节；空交付集 + visual claim → `media_unavailable`；交付 hash 匹配 → 通过；`materializeComparisonMedia` seed `contentHash` 可与 delivery Set 正向绑定。

`test/application/comparison-media.test.ts`：可用 seed 的 `contentHash` 与 `imageContentHash` 同口径；缺失文件无 hash 且无法通过交付门禁；空交付集仍拒绝 visual claim，裸 `<img>` 仍可发布。不调用付费 Runtime。`npm run check` 必须通过。
