# 会话扫描优化：可实施修改方案（基于 2026-08-23 本机基线）

> 本文修订自[会话与项目扫描优化方案](./session-discovery-optimization.md)。它不是泛化的架构设想，而是针对当前 Reprise 代码和本机真实数据的实施顺序、修改点、验证命令与停止条件。
>
> 当前结论先说清楚：Codex 的“不全”已经被数据证明主要是摘要读取限制造成的；Claude Code 当前已经合并了 transcript 和 history-only，主要问题是生命周期、去重、项目归属和“数量到底代表什么”的可解释性。第一版不应先引入 SQLite、文件 watcher 或大规模公共协议重写。

## 1. 现状与可复现基线

### 1.1 当前代码实际做了什么

入口和责任边界如下：

| 层 | 当前文件 | 实际职责 | 本次原则 |
|---|---|---|---|
| 共享文件层 | `src/products/shared/session-files.ts` | 递归枚举 JSONL、目录并发上限 8、跳过符号链接、按文件元数据排序、逐行摘要、内存缓存和 cursor | 优先在这里修复“大文件被跳过”和缓存粒度，不在 TUI 写产品分支 |
| Codex Pack | `src/products/codex/sessions.ts` | 默认读取 `${CODEX_HOME || ~/.codex}/sessions`，只接受 `rollout-*.jsonl`，解析 `session_meta`、`turn_context`、`event_msg/user_message` 等 | 保留 Codex 格式解析在 Pack 内；先做降级摘要和 metadata 诊断 |
| Claude Code Pack | `src/products/claude-code/sessions.ts` | 递归读取 `${CLAUDE_CONFIG_DIR || ~/.claude}/projects` 下 `.jsonl`，并读取同级 `history.jsonl`，合并 transcript/history-only | 不把已有 history-only 支持误写成待新增能力；重点验证合并、去重和来源展示 |
| TUI | `src/tui/controller.ts`、`src/tui/pages/intake.ts` | 按产品→项目→会话分层；初始加载与 `m` 加载更多；项目归属依赖 `SessionSummary.cwd` | 只消费产品无关字段，不在应用层判断产品类型 |

共享层当前摘要读取硬限制为 `4 MiB / 50,000 行`。任何超限异常会转成 `too-large`，该候选进入 diagnostics 而不是 `items`；因此“扫描过”不等于“显示出来”。缓存目前是进程内、最多 4 个 key，key 绑定 root、排序 fingerprint 和产品缓存 key，命中时复用整个摘要索引，但不是按单文件元数据增量复用。

### 1.2 本机基线（只记录元数据，不记录 prompt、模型正文或凭据）

#### Codex

默认目录：`C:\Users\15893\.codex\sessions`。

- 1,351 个 JSONL 文件，109 个目录，总大小约 3.8 GB。
- 最大文件约 401 MB，其余前五个大文件约 155 MB、122 MB、105 MB、105 MB。
- 当前 `dist` 中直接调用 `codexSessionAdapter.discover({ limit: 5000 })`：1,165 个 `items`、1,351 个 `scanned`、186 个 `skipped`。
- diagnostics：`too-large=158`、`invalid-metadata=27`、`invalid-jsonl=1`。
- 当前成功摘要按 cwd 聚合约 122 个项目；同一 Windows 路径存在 `C:\...` 与 `c:\...` 形式，必须验证规范化后的分组行为。

因此第一优先级不是扩大 TUI 首屏，而是使 158 个超限文件能够产出“列表级安全摘要”，并让 27 个 metadata 失败有可诊断的共同原因。不能把 186 个跳过项继续留在一个模糊的“少了多少”里。

#### Claude Code

默认目录：`C:\Users\15893\.claude\projects`；历史文件：`C:\Users\15893\.claude\history.jsonl`。

- projects 下 28 个 transcript JSONL，9 个直接目录，约 7.4 MB。
- history.jsonl 约 326 KB。
- 当前 `claudeSessionAdapter.discover({ limit: 5000 })`：145 个唯一 session，`scanned=145`、`skipped=0`，其中 transcript evidence 28、history evidence 117，聚合为约 32 个项目。
- 当前 28 个 transcript 都有 cwd；117 个 history-only 记录也有 history 中的 project/cwd。因此“Claude 大量 transcript 缺 cwd”不是当前本机主要根因，只应作为未来格式兼容测试。
- projects 目录名形如 `C--Users-15893-Documents-model-test`，但其中 `--` 的编码规则不能凭名称猜测。必须用真实 cwd 建 fixture 验证，解码失败时宁可 Unknown，不得误归属。

#### 额外 Codex 来源

本机存在 `C:\Users\15893\.codex\session_index.jsonl`，约 104 KB，观察到字段为 `id`、`thread_name`、`updated_at`。它不含 cwd，也不能直接证明与当前 rollout 文件一一对应；本方案只把它列为调查和可选补充来源，不把它未经验证地设为主索引，更不读取 Codex 凭据。

### 1.3 本基线如何重跑

新增一个仅供开发验证的脱敏统计脚本，建议放在 `scripts/session-discovery-report.ts`。它只输出：root、相对路径样本、文件大小、mtime、候选数、成功数、diagnostic code 计数、evidence/source/cwd 来源计数；禁止输出 JSONL 行内容、`display`、prompt、模型文本和凭据。

运行时使用已构建的 `dist`，例如：

```powershell
npm run build
node dist/scripts/session-discovery-report.js --product codex --limit 5000
node dist/scripts/session-discovery-report.js --product claude-code --limit 5000
```

脚本不是产品功能；若仓库已有等价 helper，应复用而不是再造一个扫描器。

## 2. 目标、非目标和第一版取舍

### 2.1 第一版完成标准

对每个配置 root 下符合 Pack 文件名规则的候选，系统必须能区分：

1. 已生成完整列表摘要并展示；
2. 生成了可用于列表的 partial 摘要并展示为“摘要不完整”；
3. 被排除（例如 `excludeRoots`）；
4. 读取失败、格式无效或 metadata 不足，并有稳定 diagnostic code。

TUI 必须把“当前页数量”“已索引可见数量”“候选数量”“跳过数量”分开；项目和会话数量不能再被读成无限接近的全量承诺。Claude 的 transcript 与 history-only 同一 session 只显示一项，同时保留 evidence 来源供详情或诊断使用。

### 2.2 明确不做

- 不扫描整个用户目录或磁盘，不启动 Codex/Claude，不联网，不读取凭据。
- 不把第三方 viewer 的字段当作官方 schema；Codex rollout 和 Claude JSONL 都按可漂移的本地格式处理。
- 不在第一版落盘索引；不引入 SQLite、watcher、全文搜索索引或 live tail。
- 不改变 freeze/import、CandidateRun 状态机、模型请求、隐私策略和 raw artifact 语义。
- 不直接修改 `docs/decisions/`，除非实现阶段真的改变公共 contract、cursor/on-disk 格式或跨模块协议；一旦改变，必须在同一变更补 decision 和反向测试。

## 3. 具体实施批次

### 批次 0：先固定可观测性（只加测试/开发报告）

**修改范围**

- 复用现有 discovery diagnostics 和 shared listing helper，补最小的脱敏报告或测试 helper。
- 建立固定 fixture，不使用本机会话内容作为提交物：
  - Codex：正常 rollout、只有头部 metadata、超过 4 MiB、超过 50,000 行、坏 JSONL、无有效 session metadata。
  - Claude：transcript、history-only、同 id 双来源、sidechain/file-history 行、缺 cwd、目录 slug 无法安全解码。

**必须验证的真实事实**

- 158 个 Codex `too-large` 中，头部是否普遍含 `session_meta`、session id、cwd 或首条 user message。
- 27 个 `invalid-metadata` 是否集中在固定缺字段/非法 timestamp，而不是文件损坏；按字段缺失计数，不输出字段值。
- Claude history 是否存在同一 `sessionId` 多条、transcript/history 时间冲突或 project/cwd 冲突。
- `session_index.jsonl` 的 id 是否能与 rollout 文件名或首行 metadata 稳定关联；若不能，停止把它纳入实现。

**Done-means**

同一 fixture 重跑两次，候选数、排序、diagnostics 计数和来源计数完全一致；报告能解释本机 Codex 的 186 个 skipped，且不泄露会话正文。

### 批次 1：共享层改为“按文件元数据增量复用 + 可降级摘要”

**修改文件**

- `src/products/shared/session-files.ts`
- `src/products/contract.ts`（仅在确实需要让 TUI 表示 partial 时增加最小可选字段）
- 对应 shared 测试和 fixture

**实施方式**

1. 把当前“cache key 绑定整个 fingerprint，变化即重建全部 index”改成进程内按 `absolute path + size + mtime` 复用单文件 `IndexedSession`；root 列表变化只重建新增、删除或元数据变化的文件。
2. 保留现有 4 个 root/index cache 的总上限，避免扫描多个产品后无限增长；`refresh` 清除对应产品/root 的单文件缓存。
3. 保留默认安全上限，不为了解决少数大文件而把 4 MiB/50,000 行直接调到 GB 级。
4. 为超限文件增加“bounded head summary”路径：从文件头部按字节/行读取有限记录，交给 Pack 的 summary consumer；至少从文件名、mtime 和已读取的有效 metadata 形成 session id/time/cwd/首条用户消息中的可用字段。读不到足够身份信息时仍返回 `too-large`，不伪造 session。
5. partial 只表示列表摘要不完整；`import/inspect` 继续走完整文件限制，不能因为列表可见就承诺可恢复。
6. `skipped` 仍统计真正没有进入 `items` 的候选，partial item 不计入 skipped；现有 `too-large` code 保留，避免增加没有证据的新诊断 code。
7. 保留 cursor 的 root/fingerprint/path 校验。增量缓存不改变排序；文件变化导致 fingerprint 改变时，旧 cursor 必须返回现有 `stale-cursor` 语义，而不是静默跳到错误位置。

**Done-means**

- 本机 Codex 的 158 个超限文件中，能安全得到身份的文件进入 `items` 并带 partial 标记；不能安全得到身份的仍明确计入 `too-large`。
- 第二次不变刷新不重新读取未变化文件；修改、截断、替换文件后只重算该文件，不能返回旧摘要。
- 4 MiB/50,000 行边界、AbortSignal、坏 JSONL、cursor stale 测试均通过。

### 批次 2：Codex Pack 修复真实缺失

**修改文件**

- `src/products/codex/sessions.ts`
- `src/products/contract.ts`（如批次 1 尚未加入 partial 标志，仅此处补）
- Codex fixture/test

**实施方式**

1. 统一 adapter/wrapper 的 `discover` 参数和默认 root 解析，明确 `CODEX_HOME`、显式 `root`、默认 home 的优先级；root 不存在返回空结果，不把它当成全盘搜索。
2. 保持 `rollout-*.jsonl` 文件名过滤；不要把任意 `.jsonl` 或 `session_index.jsonl` 混入 transcript 候选。
3. 把 Codex 真实事件解析分成“头部身份”和“完整摘要”两条路径：完整路径继续解析 `session_meta`、`turn_context`、`event_msg/user_message`；partial 路径只消费有界头部，不消费模型正文和工具输出。
4. 对 27 个 metadata 失败建立稳定分类测试。只有能够由文件名/合法事件确定 id 且不会误导用户时才生成 partial；否则保留 `invalid-metadata`。不能用文件名强行覆盖产品要求的 metadata。
5. cwd 使用事件中的绝对路径；Windows 比较时统一大小写和分隔符用于 key，但保留原始 cwd 用于展示。不得因为路径大小写不同创建两个项目。
6. 对空/非法 timestamp 使用现有文件 mtime 作为更新时间来源；不把 mtime 当作会话开始时间。
7. `session_index.jsonl` 先只在报告中记录关联率。只有建立稳定关联并有 fixture 后，才考虑作为标题/更新时间补充；它永远不能提供 cwd，也不能替代 rollout transcript。

**Done-means**

在脱敏 fixture 上旧实现会跳过而新实现可见的 Codex 大文件必须有反向测试；本机报告至少能分别回答 `items`、partial、`too-large`、`invalid-metadata`、`invalid-jsonl`，并在开发期输出 `diagnosticDetails`（如 `missing-user-message`、`partial-head-json`、`head-read-limit`）。在不变文件刷新时不会逐个重读 1,351 个文件，报告输出 `cache.unchanged` 和 `cache.re-read` 可验证这一点。

### 批次 3：Claude Code 的合并、去重和项目证据

**修改文件**

- `src/products/claude-code/sessions.ts`
- 必要时 `src/products/shared/session-files.ts` 的重复诊断聚合，但优先复用现有 code
- Claude fixture/test

**实施方式**

1. 保留当前 transcript + `history.jsonl` 合并能力；不新增第二套 scanner。
2. 以规范化 `sessionId` 去重，建立明确优先级：有 transcript 时 transcript 为主；只有 history 时保留 history-only；冲突时选择可 replay 的 transcript，并在内部 evidence/诊断中保留“双方存在”的事实。
3. 对同 id 的 cwd、startedAt、updatedAt 冲突写测试，采用“可 replay 来源优先、无法确认时 Unknown”的规则；不凭项目 slug 覆盖事件 cwd。
4. history-only 继续使用现有 locator/import 路径；一次 discovery 解析 history 一次，并把解析结果传给列表摘要，避免每个 history-only locator 重读整个文件。后续 inspect/import 仍独立读取当前 history。历史文件追加、删除、截断和重复行不能导致重复项目或不可导入 locator。
5. 第一版不实现目录 slug 兜底：当前实现只使用 transcript 事件或 history `project` 提供的可信 cwd；缺少可信 cwd 时显示 Unknown。不得将 `C--...` 直接当作真实目录，待有可靠规则和 fixture 后再单独设计。
6. sidechain、file-history、snapshot 等内部行继续由 Pack 过滤，不把每个内部行误计为会话；只把 session-level 记录计入去重集合。
7. 摘要中明确 evidence：当前 `SessionSummary.evidenceLevel` 已有 `transcript | history`，先复用它；只有 UI 确实需要同时显示两种证据时，才新增最小字段并同步 decision。history-only 是受支持的正常来源，不生成 `history-without-transcript` 失败诊断；该保留 code 不代表每条 history 记录都应计为异常。

**Done-means**

本机 28 个 transcript、117 个 history-only 在刷新后仍为 145 个唯一 session；同 id 双来源 fixture 只出现一次；一次 discovery 对 history 文件只读取一次；history-only 可从列表进入现有 inspect/import 路径；无 cwd 和未实现 slug 兜底的记录不会错误合并到任一项目。

### 批次 4：TUI 计数和项目归属

**修改文件**

- `src/tui/controller.ts`
- `src/tui/pages/intake.ts`
- `src/tui/i18n.ts`
- 现有 TUI 测试/快照

**实施方式**

1. 产品行分开显示 `visible`、`scanned`、`skipped`；不要把 `items.length` 当作 root 全量。
2. 项目标题分开显示“当前已加载会话”和“当前已加载项目”；加载更多后再更新；若存在 skipped，显示可解释的 diagnostic 数量和查看入口/日志，而不是只显示一个加号。
3. 项目 key 统一采用 Windows 大小写不敏感、分隔符统一后的绝对 cwd；原始 cwd 仅作为 label/详情展示。无可信 cwd 时使用 `productId + sessionId` 的稳定 Unknown key，不能把所有 Unknown 合并为一个项目。
4. 不在 intake 页面判断 Codex/Claude；项目归属所需的 `cwd`、`evidenceLevel`、partial 等事实由 Pack 返回。
5. “更多”继续使用现有 cursor；在新一轮 refresh 后清除旧 cursor 和产品缓存，避免用户看到混合快照。搜索只搜索已经索引的摘要，不宣称搜索全盘。
6. 对当前 1,165 个 Codex item、145 个 Claude item 设计固定显示测试，确保首屏分页和全量索引的文案不混淆。

**Done-means**

TUI 能明确表达：当前页不是全量、哪些候选未进入列表以及原因；同一 cwd 的大小写变体只形成一个项目；Unknown session 彼此独立；加载更多、刷新、搜索不重复计数。

### 批次 5：只做必要的回归和文档决策

若实现只修改现有字段、现有 diagnostics 和进程内缓存，不新增 on-disk 格式，则不新增 decision。若需要新增 `SessionSummary.partial`、覆盖统计或改变 cursor/index 协议，则同一次代码变更新增 `docs/decisions/` 记录，至少说明：字段语义、兼容旧 Pack、失败/隐私边界、为什么不落盘、反向测试。

不要为了“将来可能需要”预先加入 `DiscoveryCoverage`、`SessionProjectIdentity`、关系图、`sourceKind`、`parentSessionId`、`relatedSessionIds`、`stale-file` 等公共字段或诊断 code。这些不是当前基线必需品，且会扩大协议和测试面。

## 4. 推荐的最小代码变更清单

按以下顺序实施，后一批依赖前一批的验证结果：

1. `src/products/shared/session-files.ts`：单文件元数据缓存、bounded head summary、保持现有 cursor/diagnostics 语义。
2. `src/products/codex/sessions.ts`：partial summary、metadata 分类、Windows cwd canonicalization、wrapper 参数一致性。
3. `src/products/claude-code/sessions.ts`：按 transcript 内真实 id 的双来源去重、单次 history 摘要读取、刷新和冲突测试；第一版不实现 slug 兜底。
4. `src/tui/controller.ts`、`src/tui/pages/intake.ts`、`src/tui/i18n.ts`：计数与来源文案。
5. 仅在上述测试显示需要时修改 `src/products/contract.ts`，并同步 `docs/decisions/`。

不建议同时做全文检索、详情页重设计或 resume/import 重构；它们会掩盖扫描缺失的根因。

## 5. 测试矩阵与门禁

只改文档时，本次验证命令为：

```powershell
npm run verify:docs
git diff --check -- docs/plan/session-discovery-implementation-plan.md
```

未来改源码时遵守仓库规则：先 `npm run build`，因为测试读取 `dist/`；然后只跑直接受影响的测试，最后 `npm run check`。不得直接让 `node --test` 读取 `.ts`。

必须覆盖：

- root 不存在、root/子目录不可读、重复 root、符号链接/reparse point；
- 文件名合法但 JSONL 内容不是目标格式；空文件、坏行、尾部不完整行；
- 4 MiB 和 50,000 行边界，以及大文件 partial/仍 too-large 两条结果；
- 文件 mtime/size 未变、变更、截断、替换时的缓存失效；
- cursor 与 root/fingerprint/path 不匹配时返回 stale-cursor；
- Codex session_meta/turn_context/user_message 的 cwd、时间、id 优先级和 invalid-metadata 分类；
- Windows 路径大小写/分隔符统一但保留显示值；
- Claude transcript/history-only/同 id 双来源/重复 history/无 cwd/slug 冲突；
- 100+ 项目加载更多后的项目数、会话数、跳过数和搜索范围；
- 默认路径不会调用 Agent、读取凭据、联网或写入新的索引文件。

每个新增门禁都要有能让门禁失败的反向用例；覆盖率阈值不得降低。删除不能稳定复现的 speculative code，不用测试去覆盖死代码。

## 6. 本机验收报告格式

每次实现批次完成后保存脱敏统计（可以是命令输出，不提交会话原文）：

```text
product: codex | claude-code
root: <absolute root, if allowed in local report>
candidates: <n>
items.complete: <n>
items.partial: <n>
skipped: <n>
diagnostics: <code=count,...>
projects: <n>
evidence: <transcript/history counts>
cache: unchanged=<n>, re-read=<n>
```

验收时必须比较“修改前/修改后”，不能只报最终 `items`。Codex 的目标不是承诺 1,351 个文件全部可导入，而是对每个候选给出可解释结果；Claude 的目标不是把 145 变成任意更大的数字，而是保证 transcript/history 的唯一性、刷新一致性和项目归属正确。

## 7. 风险与停止条件

### 风险

- **格式漂移**：只依赖已观察字段和可选字段；未知行跳过并计 diagnostics，不把第三方项目的推断当官方承诺。
- **误归属**：绝对 cwd 优先；slug 解码不确定时 Unknown。错误项目比 Unknown 更严重。
- **性能**：Codex 3.8 GB 的全量逐行摘要成本是真实风险；先做有界头部读取和单文件增量缓存，禁止把限制简单调大。
- **隐私**：摘要/缓存只在进程内；任何落盘索引都必须重新设计 schema、删除策略和隐私说明。
- **兼容性**：Windows 11 是唯一验证平台；路径和 `.cmd` 启动按 Windows 优先。

### 停止条件

- 发现 partial 摘要无法可靠确认 session id，停止把该类文件加入 `items`，保留现有 diagnostic；
- 本机基线表明 `session_index.jsonl` 无稳定关联，停止接入它；
- 需要新增多个公共字段才能继续，先停在 decision 评审，不在应用层临时判断产品；
- 同一问题连续三次验证失败，暂停并记录最小复现，不扩大改动范围；
- 任何方案需要读取凭据、联网、启动真实 Runtime 或产生外部费用，立即停止。

## 8. 上游资料如何使用

这些项目用于验证常见做法（读取本地 JSONL、session 搜索、token/成本聚合、live tail），不是 Reprise 的格式契约：

- [Claude Code Trace](https://github.com/delexw/claude-code-trace)：展示了读取 `~/.claude/projects/`、搜索和 live tail 的常见实现。
- [Codex Trace](https://github.com/PixelPaw-Labs/codex-trace)：作为 Codex 本地会话查看的参考实现。
- [cc-sessions-viewer](https://github.com/jerrywu001/cc-sessions-viewer)：参考多 CLI 会话合并、搜索、resume/export 的产品交互。
- [ccusage](https://github.com/ryoppippi/ccusage)：参考 Claude 本地记录的 token/cost 统计，不直接复制其 schema。
- [OpenAI Codex](https://github.com/openai/codex)：跟踪 Codex CLI 的本地 rollout 结构变化。
- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)：跟踪 Claude Code 行为和版本变化；官方未承诺本地 JSONL 是稳定公共 API。

## 9. 最终执行顺序

现在不要直接修改 TUI 或新增公共数据模型。按以下顺序推进：

1. 用批次 0 报告重新确认本机三个数字：Codex `158 too-large / 27 invalid-metadata / 1 invalid-jsonl`，Claude `28 transcript / 117 history-only / 145 unique`。
2. 先实现 shared 单文件缓存和 bounded head summary，并用 Codex 反向 fixture 验证。
3. 再实现 Codex 的 metadata/cwd 规则；若 158 个文件多数无法安全降级，再优化诊断和按需详情，不调大硬限制。
4. 再验证 Claude 已有 history-only 合并，处理去重、刷新和项目证据；不要重复实现 scanner。
5. 最后修改 TUI 计数和项目分组，确保显示反映真实索引状态。
6. 每批次完成后执行直接受影响的门禁；只改本文档时执行第 5 节的两个命令。

这份顺序把“少显示”拆成可证明的原因，并优先修复当前本机真正占比最高的 Codex 问题。
