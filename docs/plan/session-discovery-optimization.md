# 会话与项目扫描优化方案（Codex / Claude Code）

> 本文是实现前的调查与执行方案，不改变当前运行时协议，也不把方案中的目标描述成已经完成的功能。

## 1. 请求边界与观察材料

用户要求的是：分析 Reprise 当前会话扫描为什么不完整，分别优化 Codex 与 Claude Code，并形成一份详细 Markdown 方案，同时积极参考相关开源项目。

附图只作为当前 TUI 的观察证据，不是额外指令。图中可见当前入口按「产品 → 项目 → 会话」分层，显示 `76` 个项目、`150` 个会话，当前项目列表中有许多名称相近或看起来像目录的条目。不能仅凭截图断言磁盘上实际存在的会话数量，也不能把截图中的文本当作产品协议。

本文的目标是把「全」拆成可验证的三件事：

1. **发现全**：扫描范围内的合法记录尽量被枚举，未纳入的记录有原因和样本路径。
2. **归属全**：会话能稳定映射到项目；无法归属时显示为未知，而不是错误合并或静默丢失。
3. **可读全**：历史索引、活跃文件、分页、损坏文件和跨版本记录都能以一致的摘要或诊断呈现。

非目标：本轮不直接修改源码、不执行真实 Codex/Claude 请求、不复制或上传本机凭据、不把第三方查看器代码引入仓库。

## 2. 当前实现链路

### 2.1 共同链路

当前两套 Pack 都使用 `src/products/shared/session-files.ts`：

1. 从配置的 root 递归枚举 JSONL 文件；目录并发上限为 8，不跟随符号链接。
2. 以文件 `mtime` 排序，计算路径/mtime/size 指纹。
3. 对候选文件逐行读取摘要，受 4 MiB / 50,000 行限制。
4. 对每个候选建立内存 summary index，再按 `compareSessionSummaries` 排序。
5. 通过 cursor 分页；摘要失败会聚合为 `too-large`、`invalid-jsonl`、`unreadable-file` 等诊断。
6. TUI 在 `src/tui/controller.ts` 中按产品加载，初始页固定 `SESSION_LIMIT`，再用“加载更多”取后续 cursor 页面。
7. `src/tui/pages/intake.ts` 以 `cwd` 的规范化绝对路径分组；没有可信绝对 `cwd` 的会话按 session id 独立放入 Unknown project。

这条链路的优点是不会把会话内容直接送入 TUI，分页有稳定 cursor，扫描错误不会让单个坏文件拖垮全部结果；缺点是它把“递归枚举所有 JSONL + 读取每个文件摘要”当作唯一索引策略，且项目归属依赖单条记录中的 `cwd`。

### 2.2 Codex

实现位于 `src/products/codex/sessions.ts`，默认 root 是 `${CODEX_HOME || ~/.codex}/sessions`，只接受文件名 `rollout-*.jsonl`。摘要从 `session_meta`、`turn_context`、`event_msg/user_message`、时间戳等行中提取 id、cwd、model、首条用户摘要和计数。

重点风险：

- 文件名过滤依赖当前 rollout 命名；未来/旧版记录若扩展名或命名变化，会在解析前被排除。
- `cwd` 只从 `session_meta` 的 payload 取一次；缺失、非绝对路径、路径迁移、旧格式字段名变化都会落入 Unknown project。
- Codex wrapper `discoverCodexSessions` 没有暴露 `excludeRoots`，而 adapter 有；存在“测试/脚本调用与 TUI 调用行为不一致”的兼容性缺口。
- 只在 `sessions` root 下扫描；如果用户通过不同 `CODEX_HOME`、旧目录、测试/工作区环境留下多个可用 root，当前默认入口不会合并它们。
- 摘要超过 4 MiB 或 50,000 行会被跳过，而不是用头尾窗口或增量索引降级展示；长会话因此看起来像“不存在”。

### 2.3 Claude Code

实现位于 `src/products/claude-code/sessions.ts`，默认 root 是 `${CLAUDE_CONFIG_DIR || ~/.claude}/projects`。它扫描 projects 下的 JSONL transcript，并额外读取同级 `history.jsonl`，把没有本地 transcript 的 history 项作为 `history` evidence 展示；这一步是当前实现中覆盖面最好的部分。

重点风险：

- `history.jsonl` 项与 transcript 通过 session id 去重/关联，历史项是否能定位到 transcript 取决于文件 basename 和行内 `sessionId` 一致；重命名、重复 id、旧格式会产生重复或漏项。
- 项目目录名没有被作为可靠 cwd 兜底。Claude 的 projects 目录通常已经编码了工作目录，但当前项目归属主要依赖 JSONL 行内 `cwd`；若旧记录缺少 `cwd`，就不能恢复项目。
- history 入口使用“history 文件路径 + locator”作为 source path，读取、分页、刷新和文件变化的语义与普通 transcript 不同，后续功能容易只覆盖真实 transcript 而漏掉 history-only 项。
- `history.jsonl` 与 projects transcript 都受同一摘要大小/行数限制；大文件会产生诊断，但不会给出部分摘要。
- 默认只取 `CLAUDE_CONFIG_DIR` 一个配置目录。多配置目录、显式自定义 root、环境迁移或 Windows 用户目录变化不会自动合并。
- Claude 还有 sidechain、compact summary、file-history 等行类型。当前解析会跳过部分类型，这是正确的降噪方向，但需要区分“不可用于会话列表的内部行”和“仍可用于更新时间、项目、token、分支关系的索引行”。

## 3. 为什么截图中的会话/项目可能不全

目前无需先假设是 TUI 渲染 bug，最可能是以下叠加效应：

1. **产品入口分开加载**：截图中的数字是当前产品的结果，不是 Codex 与 Claude 合并后的全局总数。
2. **固定首屏分页**：列表初始只加载一页；没有触发“加载更多”时，用户看到的是第一页，不是全量。
3. **内容大小门槛**：超过 4 MiB / 50,000 行的合法 JSONL 被归入跳过诊断，视觉上像缺失。
4. **资格过滤**：TUI 默认可显示 eligible session；没有有效 user message，或 transcript 没有 assistant message/tool call/completed turn 的记录，会被过滤。切换“全部”才能看到非 eligible 记录。
5. **路径归属过严**：cwd 不是绝对路径、字段缺失或历史格式不同，会被拆成多个 Unknown project，而不是归入正确项目。
6. **只认一个 root**：`~/.codex/sessions` 与 `CODEX_HOME`、`~/.claude/projects` 与 `CLAUDE_CONFIG_DIR` 的实际使用目录不一致时，默认扫描不会猜测其他位置。
7. **变化时机**：摘要 index 以文件路径/mtime/size 为指纹；运行中追加内容若 mtime 粒度、网络盘或原子替换行为不符合预期，刷新前可能保持旧摘要。
8. **坏文件是静默的“可见性下降”**：错误会聚合到诊断，但列表不展示坏记录占位符；用户如果不看诊断，就只会感到“不全”。

需要用真实目录清单和 diagnostics 统计验证上述排序，不能只根据 UI 印象修补某一个过滤器。

## 4. 开源项目调研与可借鉴点

本次调研优先看“直接读取本地会话文件”的项目，不把通用可观测性平台当作等价物。

### 4.1 Claude Code Trace

[delexw/claude-code-trace](https://github.com/delexw/claude-code-trace) 明确面向 `~/.claude/projects/` JSONL，提供 GUI、Web、TUI 三种入口，支持按用户消息查找、工具调用展开、token 显示、MCP 工具识别和 live tail。它说明会话浏览器通常需要把“扫描索引”和“完整查看”分离，并把活跃文件视为一等情况。

可借鉴：内容搜索索引、live tail、工具/统计字段的独立展示。不可直接照搬：其 UI 和跨平台实现超出 Reprise 当前范围，且需要逐项核对许可证和当前格式兼容性。

### 4.2 Codex Trace

Claude Code Trace README 还指向配套的 [PixelPaw-Labs/codex-trace](https://github.com/PixelPaw-Labs/codex-trace)，其定位是 OpenAI Codex session viewer。它提醒我们 Codex 不应被当作“Claude JSONL 换个产品名”：应保留 Codex rollout 的事件类型、分支/恢复关系和运行时元数据，采用独立 adapter，但共享索引接口。

### 4.3 cc-sessions-viewer

[jerrywu001/cc-sessions-viewer](https://github.com/jerrywu001/cc-sessions-viewer) 的 README 定位为多 CLI 会话查看器，覆盖 Claude、Codex、Grok、Pi、Kimi 等，提供 token 统计、全局搜索、resume 和 HTML 导出。其值得参考的是产品无关的索引字段和全局搜索体验；风险是多产品兼容常依赖启发式格式判断，Reprise 必须坚持 Pack 边界和外部 JSON 校验，不能把一个通用解析器放进应用层。

### 4.4 ccusage

[ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) 专注从 Claude Code 会话记录计算 token/cost 使用量。它代表另一类成熟做法：扫描结果不只是“有/无会话”，还应有文件级增量缓存、按日期/项目聚合和可解释的统计。Reprise 可借鉴其按文件变化重算的方向，但不能在默认扫描中引入外部费用或读取凭据。

### 4.5 共同结论

这些项目共同证明：会话管理的常见解法不是不断提高一次性扫描上限，而是：

- 显式发现 root，记录来源和扫描覆盖范围；
- 先建立轻量 metadata index，再按需读取 transcript；
- 对项目、session id、分支关系做稳定身份归一化；
- 支持搜索和 live tail；
- 把坏记录、历史记录和未关联记录显示为可解释状态。

## 5. 目标架构

### 5.1 产品无关的 Discovery Index

在不把产品类型判断放进应用层的前提下，扩展 `src/products/contract.ts` 的 discovery 端口，让 Pack 返回：

- `sourceRoot`：实际使用的 root 与发现方式（默认、环境变量、用户配置）；
- `coverage`：候选文件数、成功摘要数、history-only 数、被排除数、错误数、最后扫描时间；
- `projectIdentity`：规范化 cwd、显示 label、身份来源（event、directory、history、unknown）；
- `sessionIdentity`：product、session id、source kind、canonical source locator；
- `relations`：resume/parent/sidechain/compaction 等产品可选关系；
- `diagnostics`：按 code 聚合并提供相对样本路径；
- cursor 与 index version。

应用层只消费上述公共事实，不能判断“Claude 的目录编码”或“Codex 的 rollout 事件”。

### 5.2 Root discovery

每个 Pack 自己实现 `discoverRoots`，返回去重且可解释的 root：

- Codex：显式 `CODEX_HOME` 优先；默认 `~/.codex`；在配置存在时读取其 sessions 位置；不无边界扫描整个用户盘。
- Claude：显式 `CLAUDE_CONFIG_DIR` 优先；默认 `~/.claude`；扫描 `projects` 与同级 `history.jsonl`；允许用户配置额外 root。
- 两者都记录 root 不存在、不可读、重复和冲突，而不是静默忽略。
- 所有 root 都做 Windows `resolve`、大小写不敏感 containment 和 reparse-point 防护。

默认仍只读本地文件，不启动产品进程，不产生外部费用。

### 5.3 增量索引

第一阶段仍使用 Node 标准库，不引入数据库依赖：

1. root 枚举输出文件 identity（canonical path、size、mtime、file id 如可得）。
2. 每个文件缓存轻量索引：首个有效元数据、首个/最后一个时间戳、cwd 候选、session id、摘要、计数、格式版本、字节/行偏移。
3. 文件未变化直接复用；追加写只读取新增范围；原子替换或截断则从头重建。
4. 大文件采用头部 + 尾部 + 增量窗口策略：列表不因超限消失，但完整查看仍受单文件安全上限并给出“部分摘要”。
5. cache 版本、产品 id、root fingerprint、解析器版本必须参与 key，避免旧解析结果污染新代码。
6. 进程内缓存继续保留；需要跨启动保留时，先定义 on-disk schema 和崩溃一致性，再另行决策，不能随意写未校验 JSON。

### 5.4 项目归属

为每个产品定义候选优先级，但实现放在对应 Pack：

1. transcript/history 中的绝对 `cwd`；
2. 产品定义的项目目录编码解码结果（Claude projects 目录）；
3. 同一 session 其他行中的 cwd / project 字段；
4. 用户显式映射；
5. Unknown project。

每个候选保存来源和置信度，冲突时不擅自覆盖：显示主归属，同时在诊断中注明冲突。项目 key 使用规范化绝对路径，显示 label 只负责可读性；同名目录必须用最短足够的父路径区分。不能用 basename 作为身份。

### 5.5 合并、去重和分页

- 先按 canonical session identity 去重，再全局排序；Claude transcript 与 history entry 若同 id 且 transcript 存在，保留 transcript 记录并把 history 作为补充 metadata。
- source locator 不再依赖拼接特殊字符串作为长期协议；如果暂时兼容 locator，必须在 adapter 内解析并验证。
- cursor 绑定 root 集合 fingerprint、index version 和排序规则；root 增减或文件替换后明确返回 stale cursor。
- TUI 默认显示“已索引 X / 可见 Y / 跳过 Z”，并提供“查看诊断”和“继续加载”。不要把分页首屏数字称为总数。
- 搜索分两层：摘要/metadata 即时搜索；用户主动请求时再做 transcript 全文搜索，避免首屏读取所有正文。

## 6. Codex 专项方案

1. 将 rollout 文件名过滤抽象成 Codex adapter 的格式识别：优先文件名，必要时读取有限头窗口验证 `session_meta`，兼容历史命名而不接受任意 JSONL。
2. 从 `session_meta`、首个 `turn_context`、用户消息和恢复/父 session 字段收集候选 id/cwd/model；选择规则固定并输出来源。
3. 识别 session continuation、resume、fork 等关系；列表中按“逻辑会话”聚合，详情仍可打开具体 rollout 文件。
4. 为 `CODEX_HOME` 和默认 home 提供显式 root report；不自动遍历整个 `C:\Users`。
5. 修正公共 wrapper 与 adapter 的参数一致性，尤其是 `excludeRoots`、cursor、refresh、diagnostics。
6. 用真实脱敏 rollout fixture 覆盖：旧命名、缺 cwd、cwd 后置、超 4 MiB、追加写、重复 id、恢复链和坏尾行。

## 7. Claude Code 专项方案

1. 把 `history.jsonl` 建成独立 source kind；对 history-only、transcript、transcript+history 显示不同 evidence 状态。
2. 解码 projects 目录 slug 作为 cwd 候选，并与行内 cwd 比对；Windows 驱动器、反斜杠、连字符和大小写必须有专门 fixture。
3. 以 session id 建立去重表；transcript 优先，history 补充首条 display/cwd/time；冲突产生 diagnostics，不产生两个同名项目。
4. 识别 sidechain/agent 文件的父子关系，默认列表显示主 session，详情允许展开相关链；不要把内部 file-history 文件误当独立对话。
5. history 和 transcript 都支持增量读取；活跃 JSONL 的最后一行不完整时等待下一次刷新，不将整个文件判坏。
6. 用真实脱敏 Claude fixtures 覆盖：history-only、transcript 缺 cwd、slug 与 cwd 冲突、sidechain、compact、部分尾行、重复 session id、多配置 root。

## 8. 分阶段执行顺序

### Phase 0：可观测性与基线

- 增加只读诊断命令或测试 helper，输出 root、候选、成功、跳过、按原因计数和项目归属来源。
- 对用户本机只输出路径相对 root 的样本，不输出 prompt、模型正文、api key。
- 建立一组脱敏 fixture，并记录当前扫描结果作为基线。

完成判据：同一 fixture 可重复得到相同 identity、排序、计数和 diagnostics；能明确回答每个“缺失”记录属于哪一类。

### Phase 1：低风险覆盖修复

- 统一两个 Pack 的 root/query/wrapper 参数。
- 加入项目目录 slug 兜底、session 去重和 history/transcript evidence 标记。
- 把“可见总数”和“当前页数量”分开呈现。

完成判据：不改变现有 freeze/import 语义；现有测试通过；新增反向测试能让旧实现失败。

### Phase 2：增量索引与大文件降级

- 在 shared port 中加入可版本化的 index record。
- 实现追加、截断、原子替换检测和头尾摘要。
- 继续使用 `Value.Check` 校验任何持久化索引与外部 JSON；必要时新增架构决策记录。

完成判据：百万行级 fixture 不被整体跳过；重复刷新不重复读取未变化文件；截断/替换后不会返回旧摘要。

### Phase 3：搜索、关系和 live tail

- metadata 搜索、按项目/产品/时间过滤。
- 详情中的恢复链、sidechain、history-only 标识。
- 以 AbortSignal 和文件变更轮询实现可取消 live tail，不启动 Agent。

完成判据：搜索命中不依赖首屏分页；活跃会话追加一行后能在下一次刷新出现；退出不会遗留后台句柄。

## 9. 测试与门禁策略

每一阶段只运行直接受影响的测试；改代码必须先 `npm run build`，测试读取 `dist/`，最后按仓库要求运行 `npm run check`。本文件是文档计划，当前只需 `npm run verify:docs`，不构建。

必须新增的测试类别：

- root 不存在、权限错误、reparse point、重复 root；
- 文件名合法但内容不是目标产品格式；
- 大文件、超行数、无换行尾部、部分 JSONL 行；
- 事件 cwd、目录 cwd、history cwd 的优先级和冲突；
- 相同 session id 的 transcript/history 去重；
- cursor 在 root/index/sort 变化后的失效；
- 100+ 项目的分页、加载更多、筛选后计数；
- Codex 与 Claude 的 wrapper/adapter 参数一致性；
- 外部 JSON 和 on-disk index 的 `Value.Check` 反向用例；
- 默认路径不调用真实 Agent、不读取凭据、不产生网络请求。

## 10. 风险与取舍

- **格式漂移**：Codex rollout 与 Claude JSONL 都是产品内部记录，不应假装有永久稳定 schema。解析器必须版本化、容错并保留 diagnostics。
- **误归属比未知更糟**：路径 slug 解码失败或字段冲突时显示 Unknown/冲突，比把会话错误合并到另一个项目安全。
- **扫描性能**：全量全文索引会拖慢 TUI；先做 metadata 增量索引，全文搜索按需启用。
- **隐私**：摘要和搜索索引也是本地会话内容，默认只存进程内；跨启动持久化前必须先定义隐私、删除和 schema 规则。
- **兼容性**：Windows 11 是验证平台；路径比较大小写不敏感但保留原始显示，进程启动不得通过未加引号的 `.cmd` shim。
- **复杂度控制**：不先引入 SQLite、文件监控依赖或全局扫描；只有基线证明 Node 标准库增量方案不足时才评估依赖。

## 11. 建议的第一步

先实施 Phase 0，而不是直接改 TUI 排序。具体先拿到两份脱敏报告：

- Codex：默认 root、`CODEX_HOME` root、候选文件、合法摘要、被跳过原因、cwd 来源。
- Claude：`projects` transcript、`history.jsonl`、history-only 数量、slug/cwd 一致性、重复 session id、cwd 来源。

报告若显示绝大多数缺失来自“只加载第一页”，优先修复分页/总数文案；若来自 `too-large`，优先做增量摘要；若来自 Unknown project，优先做项目身份解码；若来自 root 不一致，先做 root 配置与合并。这样每次改动都对应可量化的缺失原因，而不是凭截图猜测。

## 参考资料

- [Claude Code Trace](https://github.com/delexw/claude-code-trace)：本地 Claude JSONL 浏览、搜索、工具调用、token 与 live tail。
- [Codex Trace](https://github.com/PixelPaw-Labs/codex-trace)：README 所指向的 Codex session viewer 项目。
- [cc-sessions-viewer](https://github.com/jerrywu001/cc-sessions-viewer)：多 CLI 会话查看、统计、搜索、resume 与导出。
- [ccusage](https://github.com/ryoppippi/ccusage)：Claude Code 本地记录的 token/cost 聚合工具。
- [OpenAI Codex 仓库](https://github.com/openai/codex)：Codex CLI 开源实现，应作为 Codex 格式变化的首要上游参考。
- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)：Claude Code 行为和版本变化的上游参考；本方案不把第三方项目的格式推断当作官方承诺。
