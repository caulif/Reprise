# 决策：候选工具事实与用量口径

状态：accepted

## 问题

候选运行的 trace 事实文件里，工具调用有三个字段系统性为 null：`name`、`input`、`exitCode`。实测 26 份数据：ACP 四家全空（有 `input` 的 call 数 dsh 0/379、kimi 0/449、minimax 0/380、qwen 0/199），claude-code 的 `input` 齐全（454/454）但 `name` 与 `exitCode` 全空，codex 是 `input` 185/196、`exitCode` 185/196、`name` 192/196——差额落在非命令类 item 上。

根因在产出端，不在汇总端：

- ACP 共享层的 `toolPayload()` 只投影 `toolCallId`/`title`/`kind`/`status`，把 `session/update` 里的 `rawInput` 和 `rawOutput` 整块丢掉。
- claude-code 的 `tool_started` 只用 `block.name` 算可见活动、`block.input` 只用于该投影，两者都不进 payload；该协议只给 `is_error`，没有退出码。
- codex 的 `mapItem` 把原始 `item` 原样留在 payload 里，键名随产品变，消费者读不到统一字段；非命令类 item 的入参在 `item.arguments` 而不是 `item.command`。
- 用量：`factsFromUsage()` 的 `total` 是整轮累计且含 cache，`input` 是去掉 cache 的新鲜 prompt，但只发布 `cached`（cache 读）而丢掉 cache 写（`cache_creation_input_tokens`），于是 `total` 无法由自身分项解释。7 条 run 出现漂移，最大一条 claude-code `run-1fd2ebdb`：in 131595 / out 116590 / total 11518329，差额 11,270,144。报告渲染的 Token 明细也只列 `input`/`output`/`cached`/`reasoning`，同一个差额在用户可见的 HTML 里同样解释不了。
- deliverables 的 `present`/`missing` 26/26 全 null，而 `declared` 有值：声明本身是中文散文（如「工作副本中修复后的源码改动」），不是路径。

## 决定

新增 `src/products/shared/tool-facts.ts`，发布产品中立的三个顶层键，与既有 `callId`/`title`/`kind`/`status` 同级：`name`（产品自己的工具标识）、`input`（工具入参文本）、`exitCode`（整数退出码）。

缺值不写键。缺键的含义是「该产品没说」；写 `0` 或空串会谎称工具无参数或成功退出。`input` 序列化为文本（字符串原样，结构走 `JSON.stringify`），过 `redactDiagnostic()` 掩码后截断到 4000 字符——先掩码再截断，跨截断点的密钥也被整段替换；上限留出余量，让读的人能区分「被截断」与「本来就这么多」。`exitCode` 只接受整数，`0` 是合法事实。

`name` 必须是产品自己的标识，不能是人类可读标题。ACP 把 `title` 定义为人类可读文本，agent 可能写成句子，所以只在 title 是裸标识符（`^[A-Za-z][\w.:-]{0,39}$`）时提升为 `name`；句子型 title 不产出 `name`，`title` 原值不覆盖。claude-code 用 `block.name`。codex 用 `item.type`——该协议没有独立的工具名字段，item 类别就是它对外声明的身份。ACP 的 `exitCode` 只从 `rawOutput.exitCode` / `rawOutput.exit_code` 取，不解析其他形状。codex 的入参取 `item.command ?? item.arguments`，让 MCP 与文件改动类 item 也有入参；payload 保留原 `item`，统一键是增量，既有消费者不受影响。

用量：`factsFromUsage()` 增加 `cacheCreation`（非零才写），并在注释里写明 `total` 是整轮累计且含 cache、`input` 是不含 cache 的新鲜 prompt，使 `total === input + output + cached + cacheCreation` 可核对。`cacheCreation` 沿 `RunInspection.tokenUsage` → `ComparisonMetricSide.tokens` → `MetricSideProjection.tokens` → `MetricSideSchema` 透传，报告 Token 明细新增「缓存写入」行，于是渲染出来的分项能对上加总的 `total`。side fingerprint 刻意不动：它是发布校验用的宿主指标摘要，加一项会让已渲染报告的指纹长度变化，把归档报告读成改动过；`tokenTotal()` 的兜底求和也不动，`factsFromUsage()` 总是产出 `total`，那条兜底在生产不可达，按「未覆盖行是死代码」的规则不往里加新逻辑。

deliverables 不做代码计算：声明是散文，`present`/`missing` 无法从散文里解析。前置条件写进事实文档——任务声明必须是仓库相对路径才可计算；在此之前该字段保持 null，含义是「不可判定」，不是「未交付」。

本决策只改 Reprise 的产出端。外部汇总脚本（另一仓库的 `extract-trace.mjs`）尚未读 `payload.name`/`input`/`exitCode`，需要单独跟进。

## 备选方案

**在 ACP 里按产品分支提取工具名。** 四家标题风格不同（dsh 裸 `pwsh`/`read`，kimi `Read`/`Bash`，minimax `bash`/`task_output`，qwen `ReadFile`/`Shell`），按产品分支等于在共享层判断产品身份，违反平台与 Pack 边界；裸标识符规则已覆盖 407/407 条实测 title，拒绝。

**把 `title` 直接当 `name` 发布。** ACP 规范把它定义为人类可读文本，句子型 title 会让 `name` 变成一句话，消费者按名字聚合统计就失效，拒绝。

**在裸标识符规则上再排掉文件名形状（`README.md`、`main.ts`、`v1.2.3`）。** 实测 407 条 title 里没有一条带点，加一层无证据的排除会把 `mcp.filesystem.read` 这类合法的点分工具名一起排掉，用猜测换猜测，拒绝；风险写进残留盲区。

**ACP 退出码从 `rawOutput` 的其它形状猜测（例如解析文本尾部）。** 没有 wire 证据说明四家会写什么，猜测产出的数字无法追溯，拒绝。

**缺值时写 `0` 或空串占位。** 会让「产品没说」和「工具无参数/成功退出」混为一谈，报告出现无法追溯的数字，拒绝。

**deliverables 用正则从散文里抽路径。** 中文散文里的名词短语不是路径，抽出来的字符串无法核对，等于伪造交付证据，拒绝。

**只写文档说明 `total` 含 cache 而不补发 `cacheCreation`。** `total` 仍然无法由自身分项解释，读者只能信或不信，拒绝。

## 影响

工具事实变成产品中立的三个顶层键，消费者不需要知道是哪个 Pack 产的。缺失仍是缺失：ACP 四家的 `usage.*` 与 `resolvedModel` 保持 null（`tokenTelemetry: 'none'` 与 manifest 的 `resolvedModel: "unknown"` 是已声明的能力边界，本决策不改变）；只有 ACP 的终态更新会把同一批事实同时写进 `tool_started` 与 `tool_finished`，claude-code 与 Host 拒绝的 `tool_finished` 不带这三个键，读的时候不能假设终态行一定有值。

`cacheCreation` 是新增的可选字段，层类型与 schema 同步放宽为可选，持久化形状向后兼容：旧报告没有该键，读取路径不变，报告的「缓存写入」行显示为缺失。

## 验证

`test/products/tool-facts.test.ts`：ACP 的 `rawInput` 与 `rawOutput.exitCode` 落成 `input`/`exitCode` 且 `tool_started` 与 `tool_finished` 同事实、`rawOutput` 是 `exit_code` 拼写时同样落值、`rawOutput` 不是对象时不造键、裸标识符 title 提升为 `name` 且 `title` 原样保留、句子型 title 不提升、缺值不造键、入参过脱敏且在 4000 字符处截断、claude-code 的 `name` 与 `input`、codex 的命令类与 `mcpToolCall` 两类 item 都带 `name` 与 `input`（后者取自 `arguments`）、`exitCode: 0` 保留。`test/application/session-usage.test.ts` 断言 `total === input + output + cached + cacheCreation`（claude 2000 / `cacheCreation` 500），并断言 codex 路径不含 `cacheCreation`（其 `input_tokens` 已含 cache 读）。报告侧断言 Token 明细里出现「缓存写入」行。

反向验证：把 `dist/` 里三处展开改回空对象、并删掉 `cacheCreation` 后，相关测试中 5 条失败（ACP 三条、claude 一条、usage 一条），失败断言形如 `actual: undefined, expected: 'grep'` 与 `expected: 500`；`npm run build` 重建后全绿。

残留盲区：ACP 规范没有 `name`/`exitCode` 字段，`name` 靠裸标识符 title 规则、`exitCode` 只靠 `rawOutput` 兜底，四家实际是否提供没有 wire 证据（本批没有抓包）；该规则也会把文件名形状的 title（`README.md`）当成工具名，实测数据里没有出现。claude-code 协议本身没有退出码，只有 `is_error`，所以它的 `exitCode` 仍是 null。codex 的 MCP 调用真实身份在 `item.server`/`item.tool`，本批只发布类别，且识别 camelCase item 拼写。ACP 四家的 `usage.*` 与 `resolvedModel` 仍 null。外部汇总脚本尚未读新键。
