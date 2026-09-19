# 决策：自定义 Harness 模型声明 inputCapabilities

状态：accepted
日期：2026-09-19

## 问题

Pi catalog 模型的 `model.input` 已进入 Session 审计与能力提示，但 openai-compatible 自定义模型在 `modelsForConfig` 中始终注册 `input: ['text']`。操作者无法声明真实视觉能力；Host 也未按能力硬拦截 outbound image block，文本模型仍可能被送上原生图片。

## 决定

1. `harness-model.json` V2 对 **openai-compatible** 增加可选 `inputCapabilities`，合法值仅 `["text"]` 或 `["text","image"]`（须含 text、无重复/未知项），经 core Schema `Value.Check`。缺省视为 text-only。
2. **pi-catalog** 配置忽略该字段；会话能力始终来自 Pi catalog 的 `model.input`，不被自定义开关覆盖。
3. TUI 仅对 openai-compatible 提供「支持图片输入」开关（默认关）；往返经 `HarnessConfigDraft.supportsImage` ↔ `inputCapabilities`。
4. Session / 工具结果：无 `image` 能力时不发送 promptImages，并剥离工具返回的 image content block；实际 outbound 的 content hash 记在本 Session 的 `agent.message_appended.images`（经 `imageRefs`），不作全局 seen。

Privacy `allowBinary` 仍是独立授权门；本决定不改 Comparison catalog 热路径。

## 备选方案

**继续硬编码 text。** 自定义视觉网关无法工作，能力声明与真实发送不一致。

**用配置覆盖 catalog。** 会把不支持视觉的目录模型标成支持，或反向关掉已声明能力。

## 影响

旧配置无字段时行为不变（text-only）。打开图片输入后自定义模型向 Pi 注册 `input: ['text','image']`。`data-claim="visual"` 与报告发布仍依赖后续包；本决定只保证能力声明与发送边界。

## 验证

`test/application/pi-model-caller.test.ts`、`test/tui/config-editor.test.ts`、`test/application/agent-host.test.ts`：旧配置、text-only、自定义 image、catalog image、未知类型拒绝、字段往返、取消、text-only 不发送 image block。不读真实本机凭据文件、不发外网请求。`npm run check` 必须通过。
