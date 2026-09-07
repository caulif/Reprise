# Harness 内部模型：第三方优先，官方登录可选

状态：计划。落地时改 [`harness-model-config.ts`](../../src/infrastructure/harness-model-config.ts)、[`pi-model-caller.ts`](../../src/infrastructure/pi-model-caller.ts)、配置 TUI，并补 `docs/decisions/accepted/`；本文不覆盖当前产品规范。

Harness 内部 Agent（Recovery、Controller、Comparison）通过 Pi 发请求。候选模型仍只来自目标 Runtime，见 [tui.md §2](../product/tui.md#2-两类模型)。本计划只改内部模型怎么注册、怎么登录、怎么在中转上活下来。

字段与默认值对齐 Pi 的 [`models.json`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md) 与 CC Switch / pi-switch 对中转的注册习惯，不把 `~/.pi/agent/models.json` 或 `~/.cc-switch/cc-switch.db` 当成 Reprise 的真相来源。

## 1. 目标

- **默认路径是第三方 API**（OpenAI 兼容网关、自建 Completions/Responses 代理）。配置页、空配置草稿、连接探测都按中转写，不按官方 Terra 目录抄一份。
- **官方登录是二等公民但完整可用**：Pi catalog 里的 ChatGPT Codex OAuth、Claude 订阅等。凭据只存在 Pi 的 `~/.pi/agent/auth.json`。
- 同一份 `createProvider` / `builtinModels` 边界：第三方在进程内注册；官方用 Pi 内置目录，不自写 HTTP 客户端。

[最短路径](../product/tui.md#31-首次设置)里的首次设置已经画成 OpenAI-compatible。空配置默认值与探测语义跟这篇走。

## 2. 非目标

- 不读取、不复制、不刷新 **Codex CLI** 的 `~/.codex/auth.json` 或 Claude Code `.credentials.json`。候选 Runtime 登录态与 Harness 计费账户分开，见 [凭据决策](../decisions/accepted/2026-08-16-local-harness-model-credentials.md) 与 [产品概述 §13](../product/overview.md#13-凭据)。
- 不把 CC Switch 数据库当作依赖；不在 Reprise 里实现 `/ps-repair` 配方引擎。
- 不把 `~/.pi/agent/models.json` 写成 Reprise 的持久化（避免改用户 Pi 会话目录）。只读导入可以后做。
- 第一批不接 Anthropic Messages / Google Generative AI 自定义网关；官方 catalog 里已有的 Anthropic 订阅仍可通过 `pi-catalog` 使用。
- 不为三个内部 Agent 拆三套 provider（仍是一份 Harness 配置）。

## 3. 两种模式

| 模式 | 配置 `kind` | 协议从哪来 | 密钥从哪来 | 何时用 |
|---|---|---|---|---|
| 第三方 | `openai-compatible` | 本配置显式 `api` / `reasoning` / 窗口 | `harness-model.json` 的 `apiKey` 或 `env:NAME` | 默认 |
| 官方目录 | `pi-catalog` | Pi `builtinModels()`（含 `openai-codex` Terra 的 Responses、窗口、reasoning） | Pi `getAuth` → `~/.pi/agent/auth.json` 或该 provider 的环境变量 | 用户切到 catalog 且 Pi 已登录 |

禁止用第三方 `kind` 去「模拟」官方 Codex：不得在自定义 `baseUrl` 上写死 `reasoning: true` 并假装这是 catalog Terra。

禁止用官方 `kind` 去填网关 `baseUrl` + API key：catalog 模型的 `baseUrl` 属于 Pi，覆盖它会把 OAuth 请求打到中转。

## 4. 对照 Pi 与 CC Switch 的注册规则

Pi 自定义 provider 的有效字段（摘录，权威在 Pi 文档）：`baseUrl`、`api`（`openai-completions` \| `openai-responses` \| …）、`apiKey`、`headers`、`compat`、模型上的 `reasoning`（文档默认 **false**）、`contextWindow`、`maxTokens`。

pi-switch / CC Switch 对中转额外强调：

- **显式选 API**，不从模型名猜测 Responses vs Completions。
- **中转 `reasoning` 默认关**；上游拒 thinking 时保持关闭，而不是按官方目录打开。
- **`maxTokens` / `contextWindow` 有填写才覆盖**；没有可信来源时用 Pi 协议缺省（128k / 16k），不从「模型名叫 Terra」推断 272k / 128k。
- 连通靠探针，不靠「列表里有这个 id」。

Reprise 的 `modelsForConfig` 用 Pi 的 `createProvider` 表达同一份形状。密钥解析继续延迟到 `auth.apiKey.resolve`，不把密钥写进事件或 provider 快照。

### 4.1 第三方注册（默认）

```text
createProvider({
  id, name, baseUrl,
  api: 配置.api ?? openai-completions,
  auth: 文件 apiKey 或 env:NAME,
  models: [{
    id, api, reasoning: 配置.reasoning ?? false,
    contextWindow: 配置.contextWindow ?? 128000,
    maxTokens: 配置.maxTokens ?? 16384,
    compat: 配置.compat（可选）
  }]
})
```

`effort` 仍写入 Pi `thinkingLevel`。`reasoning: false` 时 Pi 不应向中转发 thinking；配置页仍可保存 effort，供用户以后打开 reasoning。

可选 `compat` 第一批只开放 Pi 已文档化、且中转常用的两项：`supportsDeveloperRole`、`supportsReasoningEffort`。缺省不写，等同 Pi 默认。

### 4.2 官方目录

`kind === pi-catalog` 时不调用 `setProvider` 覆盖该 id。`getModel(providerId, modelId)` 必须能从 `builtinModels()` 取到。`hasAuth` / `validate` 只问 Pi。

官方登录流程：

1. 用户在 **Pi** 执行 `/login`（ChatGPT Codex、Claude Pro/Max 等），token 进 `~/.pi/agent/auth.json`。
2. Reprise 配置切到 `pi-catalog`，选对应 provider 与模型。
3. 连接测试走 `completeSimple`；失败文案指向「先在 Pi 登录」，不要求在 Reprise 粘贴 ChatGPT cookie。

后续切片（非本计划第一批）：TUI 调 Pi 已导出的 OAuth，浏览器回调后仍只写 `~/.pi/agent/auth.json`。Reprise 不自建 token 文件。

## 5. 磁盘格式

继续 `.reprise/harness-model.json`（Git 忽略）。在 schemaVersion 2 上增加可选字段，不升 v3：旧文件仍能读；缺省按第 4.1 节。

第三方建议形状（密钥不得出现在文档、测试夹具以外的受控文件）：

```json
{
  "schemaVersion": 2,
  "provider": { "kind": "openai-compatible", "id": "relay-id" },
  "modelId": "gateway-model-id",
  "effort": "medium",
  "baseUrl": "https://example.invalid/v1",
  "api": "openai-completions",
  "reasoning": false,
  "contextWindow": 128000,
  "maxTokens": 16384
}
```

`api` 枚举第一批：`openai-completions`、`openai-responses`。未写则 Completions。

已存在的第三方文件没有 `reasoning` 时，按 **false** 注册。需要 thinking 的网关在配置里显式 `"reasoning": true`。这是中转安全默认，不是静默升级官方 Terra。

`pi-catalog` 文件不持久化 `api` / `reasoning` / `apiKey`；保存时丢掉这些字段。

落地时补决策记录：第三方默认 reasoning、与 [内部 Agent 对齐 Pi](../decisions/accepted/2026-09-02-internal-agent-pi-alignment.md) 中「openai-compatible 缺省 128k/16k」并存；凭据边界不改 [本机 API 密钥](../decisions/accepted/2026-08-16-local-harness-model-credentials.md)。

## 6. 探测与失败分类

中转的失败模式是短探针超时、HTTP/2 断流、拒 reasoning。官方目录较少需要这些补丁，但分类应对两种模式共用。

| 行为 | 规则 |
|---|---|
| 配置页 `t` 与开跑前 `validate()` | 第三方：短文本、不强制 thinking；超时与 `streamSimple` 同量级（秒级重试），不用 15 秒硬 abort 当唯一手段 |
| `AbortSignal` / `Request was aborted` | 探针失败保持可重试，不把一切 abort 标成用户取消 |
| `HTTP/2 stream failed`、`UND_ERR_*`、`fetch failed` | 归入 `transient_network` 或 `transient_upstream`，`retryableRecoveryFailure` 允许有界重试 |
| 401/403 | `authentication`；第三方提示检查 apiKey / baseUrl，官方提示 Pi `/login` |
| 上游明确拒 thinking | 不在第一批自动改磁盘上的 `reasoning`（那是 pi-switch `/ps-repair`）；错误文案提示把 `reasoning` 设为 false |

`classifyAgentFailure` 认传输层短语；`unknown` 仍不重试。反向用例：伪造 HTTP/2 文案必须被分成可重试种类。

## 7. TUI

配置页 provider type 两档：**OpenAI-compatible（默认）**、**Pi catalog**。

第三方显示：base URL、模型 id、API 类型、reasoning 开关、effort、API key、可选窗口。API 类型与 reasoning 用 Enter 循环，不新开向导。

官方目录显示：Pi provider 列表、该 provider 模型、effort。隐藏 base URL / API key。无凭据时状态行写「在 Pi 登录后再测连接」，`t` 仍可跑以得到 Pi 的错误。

空数据目录进入配置时草稿为 `openai-compatible`，`providerId` 用稳定占位（如 `openai-compatible`），不预填 `openai-codex`。

密钥掩码、`safeConfigError`、永不把密钥写入 timeline / artifact 的规则不变。

## 8. 实施切片

1. **注册与默认**：`modelsForConfig` 按 4.1；缺省 reasoning false、显式 `api`；空草稿第三方优先；测试锁死「未写 reasoning 不得为 true」与「catalog 不走 Completions 包装」。
2. **配置读写与 TUI**：可选 `api` / `reasoning`；切换 kind 时清掉对方字段；快照若被配置行牵动则重生成。
3. **探测与分类**：validate 超时/重试；HTTP/2 与 abort 分类；`retryableRecoveryFailure` 反向用例。
4. **官方路径验收**：文档说明 `pi /login` + catalog；夹具用假 `getAuth`，不在 CI 打 ChatGPT。
5. **（后做）** 只读导入 `models.json`；TUI 内 Pi OAuth；Anthropic/Google 自定义 `api`。

切片 1–3 同一次变更可合并，只要决策记录与反向门禁用例齐。切片 5 单独计划。

## 9. 验收

- `npm run check`（含改门禁时的反向用例）。
- 第三方：无 `reasoning` 的配置注册结果为 `reasoning: false`、`api` 为 completions；文件 apiKey 仍只在 resolve 时出现。
- 官方：`pi-catalog` + `openai-codex` 不 `setProvider`；`hasAuth` 走 catalog `getAuth`。
- 文档：`npm run verify:docs`；落地后 [tui.md §3.1](../product/tui.md#31-首次设置) 与「不建立第二套凭据存储」那句改为：第三方密钥在 Git 忽略的 `harness-model.json`，官方登录只在 Pi `auth.json`。
- 不在日志、报告、事件里出现 apiKey 或 OAuth token。

## 10. 回滚

还原 `harness-model-config` / `pi-model-caller` / 配置 TUI / 本计划引用的决策。已写入的可选字段对旧版本无害（旧代码忽略未知键）。若曾把空配置默认改成第三方，回滚后新用户再次看到 catalog 默认 `openai-codex`。
