# 决策：Harness 模型凭据存于本机配置

状态：accepted

## 背景

Recovery 等 Harness Agent 需要调用用户配置的模型服务。仅允许 `env:NAME` 引用会迫使本地测试在每次进程启动时重新注入密钥，且与 Codex 的 `auth.json`、Claude Code 的 `.credentials.json` 这类本机凭据模式不一致。

## 决定

`.reprise/harness-model.json` 可在 `apiKey` 字段保存模型服务 API 密钥；该文件位于 Git 忽略的本机数据目录。`keyRef` 仍兼容 `env:NAME` 引用。此例外仅适用于 Harness 配置的模型服务凭据，不适用于 Codex 登录凭据。

所有密钥值均不得提交、打印、写入事件日志、实验 artifact、报告或错误文本。界面和诊断只显示掩码后的值；配置错误继续脱敏 endpoint 与密钥形态文本。

## 后果

- 本机配置与 Codex / Claude Code 的本地凭据模式一致，真实 smoke 可直接使用已保存的 Harness 配置。
- `.reprise*/` 必须持续被 Git 忽略；任何调整忽略规则的变更都不得使该配置进入版本控制。
- Codex 凭据边界不变：Reprise 不读取或保存 Codex 登录凭据。

## 验证

`npm run verify:docs` 验证文档链接与受控文档结构。`scripts/codex-real-recovery-smoke.ts` 从工作目录的 `.reprise/harness-model.json` 加载已验证配置。模型配置的读写、掩码和脱敏行为由现有配置相关回归测试及 `npm run check` 覆盖。