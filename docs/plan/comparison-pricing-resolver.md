# Comparison 价格解析与模型映射

状态：两批均已写入代码  
日期：2026-09-14  
替代本机草稿「Comparison 费用与模型价格架构重构规划」中尚未落地的范围；实施以本文为准。

当前已生效规则：[指标壳](../decisions/accepted/2026-09-11-comparison-host-metrics-shell.md)、[usage 三态](../decisions/accepted/2026-09-12-comparison-usage-status.md)、[首屏清晰度](../decisions/accepted/2026-09-14-comparison-report-clarity-and-review.md)、[Comparison 架构](../architecture/comparison.md)。

## 问题

2026-09-14 Deepseek 对照批次里，双侧 Token 已采集，费用卡全员「价格未配置」，窄列里还被拆成「价格未配 / 置」。原因不是采集链，也不是 Agent 漏填。

当前 `lookupModelPricing` 只对 trim + 小写后的完整字符串做精确命中，别名表只有 `gpt-5*-codex` 与少数 Claude 连字符变体。本机实测身份是：

| 侧 | 原始 ID | 表内键 |
|---|---|---|
| N7 历史 | `gpt-5.5` | 无（只有 `gpt-5` / `5.1` / `5.2`） |
| N1 历史 | `gpt-5.6-terra` | 无 |
| 候选 | `MiniMax-M3`（Claude Code 回放） | 无 |
| 比较 Agent | `deepseek/deepseek-v4.1-flash` | 无（费用卡不算对照 Agent） |

`reportFacts.metrics.*.provider` 是 Pack `productId`（`codex` / `claude-code`），不是账单供应商。把这对读成「Claude 与 Codex 官方模型」会误判缺口。

9-14 只拆开空态文案，明确不重做价格目录。要出现金额，必须做身份映射 + 可版本化目录，而不是再改「价格未配置」四个字。

## 对旧规划的评估

旧草稿方向成立的部分继续用：

- Token 聚合留在 `session-usage.ts`（Codex delta / 水位、Claude 逐条 usage、四类分项）。
- 费用仍由 Host 投影；Agent 不计算、不改指标卡。
- 运行时只读本地快照，不联网。
- 未知价格保持缺失，不用 0 冒充免费。
- `usageStatus` 与 `pricingStatus` 分开（**当前代码已经分开**，不必再做兼容层）。
- 价格缺失不让 Comparison Runner 崩溃。

旧草稿需要改掉或推迟的部分：

1. **「未采集」误显示已过时。** 当前有 Token 无价格已经是「价格未配置」。剩余工作是算出金额。
2. **查找键不要做成强制 `(providerId, modelId)`。** cc-switch 成本归因在清洗后只按模型 ID 查表；供应商前缀在清洗时被丢掉。Reprise 第一版与它对齐。Pack `productId` 继续只作报告诊断。网关差价用本地覆盖表表达，不要用 `claude-code` 去撞 MiniMax 官方价。
3. **不要运行时读 `~/.cc-switch`。** 本机 `model-pricing.json` 的 `models` 经常是空数组，单价在 cc-switch 内置 seed / SQLite 里。Comparison 报告必须可复现，不能绑本机 GUI 状态。
4. **不要把 Pi `cost: 0` 放进同一批次。** `model-caller.ts` 的零价格是 Pi 运行时描述，Comparison 并不读它。可另开任务，避免和对照费用混在一个 ADR 里。
5. **「不为所有模型手写长期静态表」不等于没有仓库内快照。** 要有一份**钉住版本的目录文件**（从 cc-switch seed / models.dev 导出），加明确的更新动作；禁止对照过程中现场猜价或拉 API。
6. **Claude Code 的角色映射不是价格映射。** 网关把非 Claude 模型路由到 sonnet/opus/haiku，账单 ID 仍是 `MiniMax-M3`。禁止用角色 ID 去套 Sonnet 单价。

## cc-switch 里实际存在的两种「映射」

### A. 网关角色映射（不算进费用）

Claude Code / Claude Desktop：非官方模型名走本地网关，填进 sonnet / opus / haiku 槽。这只决定请求怎么发出去。

### B. 价格 ID 清洗（必须接入）

与 `normalizeModelIdForPricing` / `clean_model_id_for_pricing` 相同（[cc-switch #4079](https://github.com/farion1231/cc-switch/pull/4079)、issue [#885](https://github.com/farion1231/cc-switch/issues/885)）：

1. 只保留最后一个 `/` 之后的段（`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`）。
2. 丢掉第一个 `:` 及之后（`:free`、`:8192`）。
3. trim，`@` 换成 `-`，转小写。
4. 去掉末尾 `[1m]`。

入库和查询都用清洗后的 ID。原样保存 `openrouter/anthropic/claude-sonnet-4.5:free` 会永远 miss。

清洗**不会**把 `gpt-5.5` 变成 `gpt-5`，也不会把 `gpt-5.6-terra` 变成 `gpt-5.2`。本批要出金额，目录里必须有这些键（或**显式**别名），不能靠「同系列借用」。

## 目标架构

```text
原始 model 字符串（requested / resolved / sourceRuntimeEvidence.model）
        ↓
  cleanModelIdForPricing（规则 B，与 cc-switch 同构）
        ↓
  显式别名表（连字符/点号、*-codex、已登记的同价 SKU）
        ↓
  操作者覆盖（Git 忽略，可选） → 仓库钉住的价格快照
        ↓
  PricingRecord 或 miss
        ↓
  calculateUsageCostUsd（现有四类分项）
        ↓
  reportFacts.metrics + 费用卡
```

每次对照开始时读取**当时**的快照与覆盖，把实际命中的清洗 ID、别名、费率、目录版本写入该次 `reportFacts`。重新打开旧 HTML 不重算。新对照才用新目录。

## 查找规则

解析器只做下列步骤，禁止模糊前缀、禁止「最像的 gpt-5*」、禁止用 Claude 角色价给 MiniMax。

1. 无 model 字符串 → 无价格。
2. `normalized = cleanModelIdForPricing(raw)`；空串 → 无价格。
3. 若存在操作者覆盖：先 `(productId 或 providerId, normalized)`，再单独 `normalized`。
4. 否则查快照：`normalized`，再查显式别名目标。
5. 命中且四类费率为有限非负数 → 计算 `costUsd`，`pricingStatus=collected`。
6. 有 Token、未命中 → `pricing_unavailable`（页面「价格未配置」）。
7. 记录含 NaN / 负数 / 错误单位 → `unknown`（页面「不可计算」），Runner 不崩。

允许进别名表的只有**已证明同价**的写法，例如：

- `claude-sonnet-4.5` ↔ `claude-sonnet-4-5`
- `gpt-5.2-codex` → `gpt-5.2`
- `minimax-m3` ← `MiniMax-M3`（清洗即可，不必另写）

不允许：

- `gpt-5.5` → `gpt-5`
- `gpt-5.6-terra` → `gpt-5.2`
- `MiniMax-M3` → `claude-sonnet-4-5`

日期后缀（`claude-sonnet-4-5-20250929`）只有在目录或别名里**单独登记**后才命中；第一版不自动剥 `-20yymmdd`。

## 价格目录

仓库内一份 JSON（路径实施时定，建议 `src/application/pricing-catalog.json` 或 `data/model-pricing.snapshot.json`），schema 用 TypeBox，`Value.Check` 读入。

每条记录：

- `modelId`：已清洗
- `input` / `output` / `cacheRead` / `cacheCreation`：USD / 百万 tokens
- `currency`: `USD`
- `unit`: `per_million_tokens`
- `source`: `cc-switch-seed` | `models-dev-snapshot` | `operator-config`
- 可选 `displayName`

整表一个 `version` 字符串（日期 + 来源短名），写入 `MODEL_PRICING_TABLE_VERSION` 与有费用侧的 `pricingVersion`。

**更新动作（人工、显式）：** 从钉住的 cc-switch seed 或 models.dev 导出 → 校验 schema → 改 version → 补 resolver 测试。对照运行不访问 `https://models.dev/api.json`。

本批验收最低键（清洗后）：`minimax-m3`、`gpt-5.5`、`gpt-5.6-terra`，以及现表已有的 `gpt-5` / `gpt-5.1` / `gpt-5.2` 与 Claude 四行。费率必须抄自快照来源，不在计划里手填数字。MiniMax 官方分层（≤512k / 促销五折）第一版只取快照里的**单一标价行**；分层计费不做。`gpt-5.6-terra` 若来源没有独立行，保持 `pricing_unavailable`，不要借用 `gpt-5.5`。

操作者覆盖：Git 忽略（可放 `{dataDir}/model-pricing.override.json`）。优先级高于仓库快照。密钥不得进入该文件。

## 报告投影

`usageCostUsd` 改为接收 `{ rawModelId, productId? }`，内部走解析器。历史侧用 `sourceRuntimeEvidence.model` + `source.productId`；候选侧用 `resolvedModel ?? requestedModel` + `attempt.candidate.productId`。

`MetricSideSchema` 在有命中时增加可选审计字段（名称实施时定）：`pricingModelId`（清洗后）、`pricingSource`。首屏费用卡仍只显示金额或空态。详细证据区展示原始 ID、清洗 ID、来源、版本。脚注继续写目录 version；文案可改为「按本次钉住的价格快照计算」，不必在页面写 cc-switch 产品名。

费用卡 `.num.miss`：缩小字号或 `white-space: nowrap`，避免五字折行。与金额逻辑同一批次，单独可测。

## 明确不做

- 对照过程联网；读本机 cc-switch SQLite / 空的 `~/.cc-switch/model-pricing.json` 当权威。
- 用网关角色价或同系列模型价填洞。
- 把工具调用成本算进 Token 费用。
- 让 Agent 补费用。
- 因一个模型无价格而失败整个对照。
- 打开旧报告时用新目录重算金额。
- 本批改 Pi `cost: 0`。
- 本批做 MiniMax 上下文分层价或峰谷价。

## 实施顺序

1. 把 cc-switch 清洗函数做成 `cleanModelIdForPricing`，单测覆盖 slash / colon / `@` / `[1m]` / 大小写；反向：清洗后不得把 `gpt-5.5` 变成 `gpt-5`。
2. 导出并钉住价格快照（含本批最低键，来源写入 version）；schema 校验。
3. 显式别名表 + 唯一 resolver；`usageCostUsd` 接入。
4. `comparison.ts` / `controller-queries.ts` 传入原始 ID；`pricingStatus` 逻辑保持现语义。
5. 费用卡折行 CSS。
6. 测试：命中金额、未知仍 `pricing_unavailable`、跨清洗命中 `deepseek/deepseek-v4.1-flash`（若快照有该键）、`MiniMax-M3`、别名、禁止同系列借用、Host 指标不可被 Agent 改。夹具注入固定表仍保留。
7. ADR（替代「手写 7 行精确表即全部定价」的范围，不替代 usage 三态与指标壳）。同步 `docs/architecture/comparison.md`、system prompt 快照仅当脚注文案变化。
8. `npm run build` 后 `npm run check`；文档 `npm run verify:docs`。
9. 用已有 N7 / N1 事件做一次离线重投影（不必重跑候选），确认历史 `gpt-5.5` 与候选 `MiniMax-M3` 在快照有行时出现金额。

操作者覆盖、详细证据里的费率清单、Pi 零价格已落地，见 [操作者覆盖](../decisions/accepted/2026-09-14-comparison-operator-pricing-override.md)。

## 验收

- 清洗规则与 cc-switch B 同构；网关角色映射不参与计价。
- 快照中存在的模型，有 Token 就能出 USD，并带 version。
- 快照中不存在的模型继续「价格未配置」，不是「未采集」，不是 `$0.00`。
- `gpt-5.5` 不得静默使用 `gpt-5` 单价。
- 旧成功报告金额不因后来更新快照而变。
- Agent 不能改 Host 费用数字。
- 「价格未配置」在默认桌面宽度下不折成两行。

## 验证反向

- 未知 ID 被映射到同系列已知价。
- `MiniMax-M3` 用上 `claude-sonnet-4-5`。
- 有 Token 却显示「未采集」。
- 自定义覆盖里的 `0` 在未声明免费时当成已配置免费（第二批才允许显式免费）。
- 对照运行访问网络或 `~/.cc-switch`。
