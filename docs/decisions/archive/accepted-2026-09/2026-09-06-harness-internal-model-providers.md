# 决策：Harness 内部模型第三方优先

状态：accepted

## 问题

内部 Agent 通过 Pi 发请求。自定义网关被按官方 Terra 习惯注册（Completions 上写死 `reasoning: true`、15 秒探针、HTTP/2 断流标成 `unknown`），中转无法稳定使用。官方 ChatGPT/Codex OAuth 已有 Pi catalog，却容易和 Codex CLI 登录文件混为一谈。

## 决定

第三方 `openai-compatible` 是默认配置路径：进程内 `createProvider`，显式 `api`（`openai-completions` 或 `openai-responses`），`reasoning` 缺省为 false，窗口缺省 128k/16k。密钥只在 Git 忽略的 `harness-model.json` 或 `env:NAME`。

官方订阅走 `pi-catalog` 与 Pi `builtinModels()` / `getAuth`。操作者在 Pi 执行 `/login`。Reprise 不读取、不复制、不刷新 Codex CLI `auth.json` 或 Claude Code `.credentials.json`。

空数据目录的配置草稿是 `openai-compatible`，`providerId` 为 `openai-compatible`，不预填 `openai-codex`。`pi-catalog` 保存时丢掉网关字段（`baseUrl`、`api`、`reasoning`、`apiKey`、`compat`）。

连接探针使用与 `streamSimple` 相同的重试参数，外层超时 180s，不把传输层 `AbortError` / HTTP/2 当成用户取消。`unknown` 仍不重试。

## 备选方案

**把 `~/.pi/agent/models.json` 或 CC Switch 数据库当成真相来源。** 会改用户 Pi 目录或绑死 sqlite，和 Reprise 本机数据目录冲突。

**用 Codex CLI 登录给内部 Agent 计费。** 与候选 Runtime 抢同一份 token，违反凭据边界。

**自定义网关默认 `reasoning: true`。** 中转常拒 thinking，且会把网关 Terra 伪装成官方目录。

## 影响

- 已有第三方文件未写 `reasoning` 时按 false 注册；需要 thinking 时显式打开。
- v1 文件上的 `baseUrl` 不再覆盖 catalog 模型。
- 配置页为第三方增加 API / reasoning 循环项；官方目录隐藏密钥与 URL。

## 验证

- `modelsForConfig` 在未写 `reasoning` 时注册 `false`，且 `pi-catalog` 不 `setProvider`。
- HTTP/2 与 `Request was aborted` 分为 `transient_network` 且可重试；`Pi model request was aborted.` 仍为取消。
- `npm run check`。
