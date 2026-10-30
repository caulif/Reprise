# 决策：候选工具事实与用量口径

状态：accepted

## 问题

候选运行的 trace 事实文件里，工具调用有三个字段系统性为 null：`name`、`input`、`exitCode`。实测 26 份数据：ACP 四家全空（有 `input` 的 call 数 dsh 0/379、kimi 0/449、minimax 0/380、qwen 0/199），claude-code 有 `input` 454/454 但 `name` 与 `exitCode` 全空，只有 codex 齐全（`input` 185/196、`exitCode` 185/196、`name` 192/196）。

根因在产出端，不在汇总端：

- ACP 共享层的 `toolPayload()` 只投影 `toolCallId`/`title`/`kind`/`status`，把 `session/update` 里的 `rawInput` 和 `rawOutput` 整块丢掉。
- claude-code 的 `tool_started` 只用 `block.name` 算 `live`，`name` 与 `block.input` 不落事件；该协议只给 `is_error`，没有退出码。
- codex 的 `mapItem` 把原始 `item` 原样留在 payload 里，键名随产品变，消费者读不到统一字段。

用量口径：`factsFromUsage()` 的 `total` 是整轮累计且含 cache，`input` 是去掉 cache 的新鲜 prompt，但只发布 `cached`（cache 读）而丢掉 cache 写（`cache_creation_input_tokens`），于是 `total` 无法由自身分项解释。7 条 run 出现漂移，最大一条 claude-code `run-1fd2ebdb`：in 131595 / out 116590 / total 11518329，差额 11,270,144。

deliverables 的 `present`/`missing` 26/26 全 null，而 `declared` 有值：声明本身是中文散文（如「工作副本中修复后的源码改动」），不是路径。

## 决定

新增 `src/products/shared/tool-facts.ts`，发布产品中立的三个顶层键，与既有 `callId`/`title`/`kind`/`status` 同级：`name`（产品自己的工具标识）、`input`（工具入参文本）、`exitCode`（整数退出码）。

缺值不写键。缺键的含义是「该产品没说」；写 `0` 或空串会谎称工具无参数或成功退出。`input` 序列化为文本（字符串原样，结构走 `JSON.stringify`），过 `redactDiagnostic()` 掩码后截断到 4000 字符：上限比消费者 2000 字符的显示上限更长，读的人才能区分「被截断」与「本来就这么多」。`exitCode` 只接受整数，`0` 是合法事实。

`name` 必须是产品自己的标识，不能是人类可读标题。ACP 把 `title` 定义为人类可读文本，agent 可能写成句子，所以只在 title 是裸标识符（`^[A-Za-z][\w.:-]{0,39}$`）时提升为 `name`；句子型 title 不产出 `name`，`title` 原值不覆盖。claude-code 用 `block.name`，codex 用 item 的 `kind`。ACP 的 `exitCode` 只从 `rawOutput.exitCode` / `rawOutput.exit_code` 取，不解析其他形状。codex 的 payload 保留原 `item`，只**增加**统一键，既有消费者不受影响。

用量：`factsFromUsage()` 增加 `cacheCreation`（非零才写），并在注释里写明 `total` 是整轮累计且含 cache、`input` 是不含 cache 的新鲜 prompt。`comparison.ts` 的 `tokenTotal()` 兜底同步改为按 `input + output + cached + cacheCreation` 求和；`cacheCreation` 沿 `RunInspection.tokenUsage` → `ComparisonMetricSide.tokens` → `MetricSideProjection.tokens` → `MetricSideSchema` 透传。

deliverables 不做代码计算：声明是散文，`present`/`missing` 无法从散文里解析。前置条件写进事实文档——任务声明必须是仓库相对路径才可计算；在此之前该字段保持 null，含义是「不可判定」，不是「未交付」。

本决策只改 Reprise 的产出端。外部汇总脚本（另一仓库的 `extract-trace.mjs`）尚未读 `payload.name`/`input`/`exitCode`，需要单独跟进。

## 备选方案

**在 ACP 里按产品分支提取工具名。** 四家标题风格不同（dsh 裸 `pwsh`/`read`，kimi `Read`/`Bash`，minimax `bash`/`task_output`，qwen `ReadFile`/`Shell`），按产品分支等于在共享层判断产品身份，违反平台与 Pack 边界；裸标识符规则已覆盖 407/407 条实测 title，拒绝。

**把 `title` 直接当 `name` 发布。** ACP 规范把它定义为人类可读文本，句子型 title 会让 `name` 变成一句话，消费者按名字聚合统计就失效，拒绝。

**ACP 退出码从 `rawOutput` 的其它形状猜测（例如解析文本尾部）。** 没有 wire 证据说明四家会写什么，猜测产出的数字无法追溯，拒绝。

**缺值时写 `0` 或空串占位。** 会让「产品没说」和「工具无参数/成功退出」混为一谈，报告出现无法追溯的数字，拒绝。

**deliverables 用正则从散文里抽路径。** 中文散文里的名词短语不是路径，抽出来的字符串无法核对，等于伪造交付证据，拒绝。

**只写文档说明 `total` 含 cache 而不补发 `cacheCreation`。** `total` 仍然无法由自身分项解释，读者只能信或不信，拒绝。

## 影响

工具事实变成产品中立的三个顶层键，消费者不需要知道是哪个 Pack 产的。缺失仍是缺失：ACP 四家的 `usage.*` 与 `resolvedModel` 保持 null（`tokenTelemetry: 'none'` 与 manifest 的 `resolvedModel: "unknown"` 是已声明的能力边界，本决策不改变），deliverables 的 `present`/`missing` 在任务声明不是路径前仍为 null。

`cacheCreation` 是新增的可选字段，四层类型与 schema 同步放宽为可选，持久化形状向后兼容：旧报告没有该键，读取路径不变。

## 验证

`test/products/tool-facts.test.ts` 六条：ACP 的 `rawInput` 与 `rawOutput.exitCode` 落成 `input`/`exitCode`（`tool_started` 与 `tool_finished` 同事实）、裸标识符 title 提升为 `name` 且 `title` 原样保留、句子型 title 不提升、缺值不造键、入参过脱敏、claude-code 的 `name` 与 `input`、codex 的 `name` + `input` + `exitCode: 0`。`test/application/session-usage.test.ts` 新增一条断言 `total === input + output + cached + cacheCreation`（claude 2000 / `cacheCreation` 500），并断言 codex 路径不含 `cacheCreation`（其 `input_tokens` 已含 cache 读）。

反向验证：把 `dist/` 里三处展开改回空对象、并删掉 `cacheCreation` 后，12 条中 5 条失败（ACP 三条、claude 一条、usage 一条），失败断言形如 `actual: undefined, expected: 'grep'` 与 `expected: 500`；`npm run build` 重建后 12/12 通过。

残留盲区：ACP 规范没有 `name`/`exitCode` 字段，`name` 靠裸标识符 title 规则、`exitCode` 只靠 `rawOutput` 兜底，四家实际是否提供没有 wire 证据（本批没有抓包）；claude-code 协议本身没有退出码，只有 `is_error`，所以它的 `exitCode` 仍是 null；外部汇总脚本尚未读新键。
