# 会话扫描完整性与启动全量展示：Codex Desktop / Claude Code 实施方案

> 本文是针对当前 Reprise 代码、Windows 本机 Codex Desktop 数据和用户界面目标的实施计划。目标不是把 JSONL 扫描的 `limit` 调大，而是让发现层先建立完整的会话目录（catalog），再由 TUI 对目录做视口渲染。
>
> **验收目标**：启动后无需按 `m`，项目列表立即包含所有可发现项目；每个项目包含全部可发现会话；无项目归属的会话统一出现在“项目外会话”；搜索、计数和排序针对全量目录；无法读取正文的索引记录也不被静默丢弃。

## 1. 结论摘要

截图中的 Codex Desktop 侧栏和 Reprise 当前页面不是同一个数据模型：

- Codex Desktop 展示的是“项目 + thread”的本地目录，项目归属来自 Desktop 的项目状态和 thread 索引。
- Reprise 当前 Codex Pack 主要递归扫描 `~/.codex/sessions` 下的 `rollout-*.jsonl`，从 transcript 的 `cwd` 等字段推断项目，再用 `SESSION_LIMIT = 150` 分页交给 TUI。
- 因此，扩大 JSONL 扫描范围只能修复一部分漏项，不能复现 Desktop 的项目顺序、项目外会话和 catalog-only thread。

本方案采用以下数据流：

```text
Codex Desktop catalog:
  state_5.sqlite.threads
  + .codex-global-state.json
  + rollout_path -> 可选 JSONL transcript

Claude Code:
  ~/.claude/projects/**/*.jsonl
  + ~/.claude/history.jsonl

                 ↓
      产品 Pack 内部的全量 SessionCatalog
                 ↓
      统一的项目分组 / projectless 分组
                 ↓
      TUI 全量索引 + 视口渲染
```

启动列表只读取轻量元数据；正文、完整事件和 freeze/import 仍在用户打开详情或执行操作时按需读取。这同时满足“启动即显示全部”和“不在启动时读取约 3.8 GB rollout 正文”。

## 2. 证据与当前实现

### 2.1 本机证据

本机 Codex 数据根目录为 `%USERPROFILE%\\.codex`，其中存在：

- `sessions/`：约 1,351 个 JSONL rollout 文件，累计约 3.8 GB，最大文件约 401 MB；文件数量会随使用变化，不把这些数字当作固定断言。
- `state_5.sqlite`：包含 `threads`、`projects`、`project_roots` 等表；调查时 `threads` 约 1,359 行。
- `thread_history_1.sqlite`：包含 `thread_items`、`thread_turns` 等历史投影表。
- `.codex-global-state.json`：包含 `local-projects`、`project-order`、`thread-project-assignments`、`projectless-thread-ids`、`thread-workspace-root-hints` 等键。
- `session_index.jsonl`：存在，但已观察到的字段主要是 `id`、`thread_name`、`updated_at`，不含足够的项目归属信息，只能作为可选补充来源。

调查时发现 `local-projects` 约 47 个、`projectless-thread-ids` 约 32 个、`thread-project-assignments` 约 120 个；这类信息与截图中 Desktop 的项目侧栏更直接对应。数据库与文件会持续变化，实施时应由脱敏报告重新采样，而不是硬编码样本数量。

**隐私边界**：报告只能输出相对路径、计数、大小、时间、状态码和哈希/截断 ID；不得输出 prompt、模型正文、完整标题、凭据或 `auth.json` 内容。

### 2.2 Reprise 当前代码路径

| 层 | 文件 | 当前责任 | 造成的可见影响 |
|---|---|---|---|
| 共享发现 | `src/products/shared/session-files.ts` | 递归列举 JSONL、按 mtime 排序、摘要读取、缓存、cursor 分页 | 超过 4 MiB / 50,000 行的文件可能只进入 diagnostics，不进入 `items` |
| Codex Pack | `src/products/codex/sessions.ts` | 读取 `sessions` 下 rollout，解析 `session_meta`、用户消息、时间和 cwd | 未读取 Desktop SQLite 和 global state，无法得到 Desktop 的完整 thread/project 目录 |
| Claude Code Pack | `src/products/claude-code/sessions.ts` | 合并 transcript 与 `history.jsonl`，支持 history-only | 需继续验证 transcript `sessionId` 去重和历史生命周期，不是本轮 Codex 漏项的主要根因 |
| TUI 控制器 | `src/tui/controller.ts` | 首页按 `limit` 获取会话，`m` 请求下一页，刷新时重建页 | `items.length` 只是已加载页数；用户未按 `m` 时不能看到全量项目/会话 |
| TUI 分组 | `src/tui/pages/intake.ts` | 依据 `SessionSummary.cwd` 分组，缺少 cwd 时走 Unknown | 不能表达 Desktop 的正式项目、项目外 thread 和“索引有但正文缺失” |

共享层的 bounded summary、缓存和 cursor 对大目录有价值，但它们解决的是扫描成本，不是 Desktop catalog 的缺源问题。不能把 `scanned` 等同于“用户可见会话数”，也不能把 `skipped` 等同于“会话不存在”。

### 2.3 漏项分类

每个候选最终必须进入以下一种可解释状态，而不是静默消失：

1. **catalog + transcript**：有 Desktop/Claude 目录记录，也能关联正文文件。
2. **catalog-only / source-missing**：目录或索引中有记录，但关联 transcript 不存在、不可读或格式不兼容；仍显示标题、时间、项目和“正文不可读取”。
3. **rollout-only / unindexed**：有合法 rollout 文件，但没有对应 Desktop thread；显示在“项目外会话”或“未编入桌面索引”子状态。
4. **projectless**：thread 明确列入 `projectless-thread-ids`，或没有项目但有有效 thread 身份；归入统一的“项目外会话”。
5. **unknown**：只有在身份、路径和归属都无法可靠确认时使用；不能把每个缺 cwd 的正常会话都拆成一个 Unknown 项目。
6. **excluded/archived**：仅当源数据明确标识归档/排除时隐藏；默认目录页仍应可通过筛选查看，避免误认为未扫描到。

## 3. 目标数据模型

### 3.1 Pack 内部先扩展，不立即重写公共 contract

先在 Codex adapter 内部定义目录类型，避免把 SQLite 私有字段泄漏到跨产品 `SessionSummary`：

```ts
type SessionCatalogEntry = {
  sessionId: string;
  source: 'codex-state' | 'codex-rollout' | 'claude-transcript' | 'claude-history';
  sourcePath?: string;
  title?: string;
  preview?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  projectKey: string;
  projectName: string;
  availability: 'readable' | 'catalog-only' | 'unindexed' | 'invalid';
  archived?: boolean;
  pinned?: boolean;
  diagnostics?: readonly string[];
};
```

若 TUI 需要项目层结构，新增最小的产品无关 `SessionProject` / `SessionCatalog` 端口，先由 `src/core/runtime.ts` 端口（如适用）和两个 Pack 实现；不要在 TUI 判断 `codex` 或 `claude`。所有从 SQLite/global-state/外部 JSON 映射来的对象都经过 `src/core/schema.ts` 的 `Value.Check`；同进程内部的已校验对象不重复加运行时校验。

项目 key 应稳定且可解释：

```text
local-project:<Codex project id>
cwd:<canonical Windows path>
projectless
unknown
```

显示名与 key 分离。路径比较使用 Windows 大小写不敏感和分隔符规范化，但保留源中的原始显示路径；不得通过拼接字符串误启动或访问文件。

### 3.2 Codex 归属优先级

对每个 thread 按下列顺序决定项目：

1. global state 的 `thread-project-assignments[threadId]`；
2. `state_5.sqlite.threads.project_id` 与匹配的 `local-projects`；
3. `thread-workspace-root-hints[threadId]` 与项目根目录匹配；
4. rollout/session metadata 的 cwd 与已知项目根目录匹配；
5. 明确命中 `projectless-thread-ids`，或没有项目但 thread 身份有效 → `projectless`；
6. 仍无法确认 → `unknown`。

`projectless-thread-ids` 优先于 cwd 推断：用户在 Desktop 中明确把会话放在项目外时，不得因 transcript 恰好带有某个 cwd 而重新归入项目。多个来源冲突时保留诊断 `conflicting-project-source`，选择更高优先级来源，不静默覆盖。

## 4. Codex 具体改造步骤

### 4.1 新增只读 SQLite catalog reader

建议新增 `src/products/codex/catalog.ts`，只负责：

1. 定位 `%CODEX_HOME%`，默认回退到用户目录；不得读取凭据文件。
2. 以只读方式打开 `state_5.sqlite`，查询 `threads` 的必要字段；只选择实际存在且已验证的列，不使用 `SELECT *`。
3. 读取 `thread_history_1.sqlite` 仅用于补充已验证的预览/历史状态字段；第一版可不把它作为 session 是否存在的唯一依据。
4. 将 SQLite 行转换为经过 schema 校验的 `CodexThreadRecord`。
5. 找不到数据库、数据库锁定、WAL 不完整、表/列未知或 SQLite 损坏时，返回诊断并回退 rollout scanner，不让启动失败。
6. 数据库只读失败时不得复制、修复、删除、checkpoint 或写入 Codex 数据库。

SQLite 是 Codex Desktop 的本机实现细节，不当作永久稳定 API。读取器必须带 `schemaVersion/columns` 能力探测和明确诊断；未知版本使用安全的已知列子集，无法保证身份时降级为 rollout-only/unknown。

依赖选择应先检查项目已有依赖和 Node 运行时能力；若没有可用 SQLite reader，才评估一个最小、Windows 11 可验证的依赖。不要为了计划引入多个 ORM、数据库迁移或常驻服务。

### 4.2 global state reader 与项目实体

建议新增 `src/products/codex/global-state.ts`，只做以下工作：

- 读取 `.codex-global-state.json`；
- 用 TypeBox schema 校验顶层结构和必要字段，未知字段允许保留但不依赖；
- 建立 `local-projects` 与 `project-order` 的项目目录，保留 Desktop 顺序；
- 建立 thread assignment、projectless 集合和 workspace root hints 的只读映射；
- 对坏 JSON、字段类型错误、未知项目 id 记录 diagnostics，继续显示可恢复条目。

项目实体至少需要：`id`、显示名、primary folder、secondary folders（若字段存在）、顺序位置和来源。不要仅用 cwd 的 basename 生成项目名；没有正式项目实体时才使用规范化 cwd 作为回退项目。

### 4.3 thread 与 rollout 的关联

关联顺序必须是可验证的：

1. `threads.id` 与 rollout 内容中的 session/thread id 精确相等；
2. `threads.rollout_path` 在 `%CODEX_HOME%` 允许目录内解析，并与候选文件做规范化绝对路径比较；
3. 仅在 fixture 证明 basename 规则稳定时，才允许 `rollout-<id>.jsonl` 的 basename 关联；
4. 仍无法关联时保留两条记录并标记 `catalog-only` 或 `unindexed`，禁止按 title/cwd 模糊合并。

`rollout_path` 是外部数据，必须做：绝对路径解析、规范化、根目录边界检查、`isFile` 检查和重解析点策略检查。不能读取 `%CODEX_HOME%` 之外的任意路径。读取 rollout 正文仍复用 `src/products/codex/sessions.ts` 和 `src/products/shared/session-files.ts` 现有 helper。

### 4.4 启动读取策略

Codex discovery 的默认流程改为：

1. 并行读取 state catalog 和 global state；
2. 以所有 `threads`、正式项目和 projectless IDs 建立全量目录；
3. 将 rollout 文件清单与 catalog 做集合并；
4. 对每个目录条目先使用 SQLite 的 title/preview/time/cwd；
5. 只对 catalog 缺少关键字段、rollout-only 文件或用户打开详情的条目读取 bounded transcript summary；
6. 返回完整 catalog 和 diagnostics，一次性供 TUI 建立项目树。

这不是把“第一页”改成 5,000 条；返回结果本身不应因 UI limit 截断。正文按需读取，且任何无法读取的条目保持可见。

## 5. Claude Code 补强

Claude 不使用 Codex 的 SQLite/global state。继续扫描：

- `~/.claude/projects/**/*.jsonl` transcript；
- `~/.claude/history.jsonl` history-only 来源。

需要实施的修正：

1. history 文件在一次 discovery 内只解析一次，按真实 `sessionId` 建索引；
2. transcript 内的 `sessionId` 是去重主键，不能只用文件 basename；
3. transcript 与 history 同一 session 合并为一条，保留 evidence/source 标记；
4. history-only 记录正常进入全量 catalog；没有可靠 cwd 时进入项目外或 Unknown，不根据目录 slug 猜路径；
5. 处理 history 记录先于 transcript 出现、transcript 被删除、history 重复和时间倒序；
6. 不新增未经 fixture 证明的 slug 反解码规则。误归属比 Unknown 更严重。

Claude 的项目归属可按真实 cwd 规范化；没有 cwd 的会话进入统一“项目外会话”，而不是丢弃。

## 6. TUI：全量 catalog，视口渲染

### 6.1 移除 `m` 作为发现机制

在 `src/tui/controller.ts` 和 `src/tui/pages/intake.ts` 中：

- 删除 `SESSION_LIMIT = 150` 对数据集的截断意义；
- discovery 返回全量 catalog，`items.length` 表示全量候选，而不是当前页；
- 项目数、会话数、diagnostics 使用全量快照计算；
- `m` 可保留为兼容快捷键，但按下后不能改变“是否发现全部”的语义；可以改为无操作提示、刷新或跳转行为；
- 搜索、项目筛选、排序在完整 catalog 上执行，不允许只在当前 viewport 或第一页上执行。

“全量展示”不等于一次创建数千个终端控件。内存保留完整轻量条目，绘制层只根据当前滚动位置计算可见行（viewport）；这属于渲染优化，不是用户可感知的分页。若现有 TUI 没有虚拟列表，先用扁平行数组 + 可见区切片实现最小版本，不新增 UI 框架。

### 6.2 启动期间的状态

catalog 读取应异步执行，但首屏必须明确显示状态：

- catalog 完成前：显示“正在读取本地会话目录”；
- catalog 完成后：立即显示完整项目树和全量计数；
- transcript 补充失败：项目和会话仍显示，行上标记“仅索引/正文不可读”；
- catalog reader 不可用：回退 rollout scanner，并显示来源和降级原因。

不能为了等待全部正文而阻塞首屏，也不能把“尚未读取正文”误报为“没有会话”。

### 6.3 项目外会话

项目列表固定包含一个产品无关的虚拟项目：

```text
项目外会话（projectless）
```

它收纳：

- Codex global state 明确列出的 projectless thread；
- 有有效 thread ID 但没有 project assignment、且 cwd 无法匹配正式项目的会话；
- rollout-only/unindexed 会话（可在行级显示来源）；
- Claude history-only 且没有可靠项目 cwd 的会话。

`unknown` 只保留给无法确认 session identity 的异常记录；“项目外”不是错误状态。正式项目即使当前没有可读 transcript，也应保留在树中，并显示 0 条可读正文/若干 catalog-only 条目。

## 7. 兼容、错误与安全边界

- 所有本机外部 JSON、SQLite 查询映射和持久化索引均先过 `Value.Check`；错误记录不含正文和凭据。
- SQLite 以只读连接打开；不修改 Codex 文件，不复制数据库，不执行 checkpoint/vacuum。
- 数据库处于 WAL、文件锁定、版本未知或损坏时必须可降级；诊断码至少区分 `catalog-unavailable`、`catalog-schema-unsupported`、`catalog-read-error` 和 `source-missing`。
- 真实路径使用 `resolve`/规范化后做根目录边界检查；拒绝越界 `rollout_path`、符号链接逃逸和非文件目标。
- 不读取 `auth.json`、`.credentials.json` 或环境变量中的密钥；不联网、不启动 Codex/Claude Agent、不产生外部费用。
- 数据库和 JSON 状态随产品升级可能改变；读取器必须有最小列投影、版本探测、fixture 和回退路径。
- 标题、preview、cwd 仅作为展示数据，不能用作唯一身份或合并键。

## 8. 实施批次与文件范围

### Phase 0：证据与 fixture

新增脱敏报告/fixture，覆盖：SQLite threads、global state、catalog-only、rollout-only、projectless、坏 JSON、未知列和路径越界。报告输出计数和状态码，不输出内容。完成标准：可重现地解释每一个“没显示”的候选属于哪一类。

### Phase 1：Codex catalog

新增 `src/products/codex/catalog.ts`、`src/products/codex/global-state.ts` 及其 schema/test；在 Codex adapter 内合并 catalog 与 rollout，保持现有 freeze/import 路径。完成标准：本机 `threads` 中的正常记录全部进入 catalog；数据库不可用时仍能回退 JSONL。

### Phase 2：统一全量项目树

在不把产品判断写进 TUI 的前提下，扩展最小 discovery 返回值，表达 projectless、availability、全量计数和 diagnostics。同步更新 `src/tui/controller.ts`、`src/tui/pages/intake.ts`。完成标准：启动不按 `m` 也能看到全部项目和会话，搜索不受分页影响。

### Phase 3：Claude 对齐与性能

补齐真实 sessionId 去重、history 单次解析和全量 history-only 展示；对 JSONL 做按文件元数据增量缓存，详情时再读正文。完成标准：Claude 的 transcript/history 生命周期和 Codex 的 catalog-only/unindexed 状态都有明确可见结果。

任何跨模块协议或 on-disk 索引格式在实施同一变更时，必须新增/更新 `docs/decisions/` 决策记录；当前本文本身不改变协议和磁盘格式。

### 8.1 实施记录（2026-08-24）

- [x] **Phase 0：证据与 fixture**：`test/codex-catalog.test.ts` 已覆盖正常/损坏/缺表/缺列 SQLite、catalog-only、项目冲突、projectless、越界 rollout 路径；151 条会话全量分组反向用例已保留。
- [x] **Phase 1：Codex catalog**：`catalog.ts` 只读探测 `threads` 能力并按存在列投影；`global-state.ts` 校验 global state；无法读取正文的 thread 保留为 `catalog-only`，无 `rollout_path` 列时仍不丢失索引记录；rollout scanner 作为回退。
- [x] **Phase 2：统一全量项目树**：Codex/Claude 初次 discovery 在未传 cursor 时建立完整轻量目录；TUI 在完整目录上排序、搜索、筛选和项目分组，`m` 不再决定是否发现全部会话，视口只切片绘制；项目外会话和索引状态可见。
- [x] **Phase 3：Claude 对齐与性能**：Claude transcript 与 `history.jsonl` 按真实 session ID 去重，history-only 使用 locator 保留；共享 discovery 使用 bounded summary 与未变化文件缓存，详情时再读正文。
- [x] **语言一致性补充**：会话项目/预览/状态字段和确认、预检页面均通过 `src/tui/i18n.ts` 渲染；中文模式不再混入上述中间英文标签。

以上各项的代码与测试已修改；最终完成以第 10 节的三个门禁命令及相关 dist 测试结果为准。

## 9. 测试与验收

代码变更必须先 `npm run build`，测试从 `dist/` 读取。只改本文档时运行 `npm run verify:docs` 和 `git diff --check -- docs/plan/session-discovery-all-at-once.md`。

最低测试集合：

- SQLite 正常读取、只读/WAL、锁定、损坏、缺表、未知列/版本；
- global state 正常、坏 JSON、未知 project id、assignment 冲突、projectless ID；
- thread ↔ rollout 精确关联、缺源、rollout-only、重复和 ID 不一致；
- Windows 路径大小写、分隔符、重解析点和越界路径；
- 4 MiB/50,000 行以上文件的 catalog 可见性与 bounded summary 降级；
- 全量项目和会话在不触发 `m` 时可见，项目数/会话数与快照一致；
- 搜索、排序、筛选针对全量目录；
- Claude transcript/history 去重、history-only、无 cwd 的项目外会话；
- 默认路径不访问凭据、不联网、不启动外部 Runtime。

建议加入一条反向用例：构造 151 个会话，首次 discovery 后断言全量 151 个均可搜索和分组；旧的 `limit=150` 实现必须失败。再构造一个只有 `state_5.sqlite` 记录、没有 rollout 文件的 thread，断言它仍在项目树中并标记 `catalog-only`。

## 10. 性能目标与停止条件

性能目标应以本机脱敏报告和 fixture 校准，不先承诺与机器无关的毫秒数：

- 启动列表只读取 SQLite/global state 和轻量文件元数据，不顺序读取全部 rollout 正文；
- 目录大小、项目数、session 数在一次快照中稳定；
- 未变化文件刷新不重复读取其摘要；
- 视口渲染成本与可见行数近似相关，而非与全部正文大小相关；
- 任何失败候选有可解释状态和诊断计数。

停止条件（Done-means）：

```powershell
npm run build
npm run check
npm run verify:docs
```

并满足：脱敏本机报告中，Codex Desktop `threads`、global state 项目/项目外集合和 rollout 文件的差集均有分类；启动 TUI 不按 `m` 即能展示完整项目树；Claude history-only 记录不会因分页或去重丢失；没有凭据、正文或外部 Runtime 副作用。

## 11. 不做的事情

- 不把 `SESSION_LIMIT` 简单改成超大常数来掩盖 catalog 缺失。
- 不在启动时把 3.8 GB rollout 全文读入内存或建立未经设计的全文索引。
- 不把 `session_index.jsonl` 当作唯一真相，不把 SQLite 私有表当作永久官方 API。
- 不通过 cwd basename、title 或文件名模糊合并 thread。
- 不复制、修复、迁移或删除 Codex Desktop 数据库。
- 不把 projectless 会话隐藏到 Unknown，不把读取失败当成不存在。
- 不为本次列表发现启动 Codex/Claude Agent、调用网络或产生模型费用。

## 12. 参考资料

- [OpenAI Codex 开源仓库](https://github.com/openai/codex)：跟踪 CLI rollout 格式和实现变化。
- [OpenAI Learn：Codex Desktop 更新](https://learn.chatgpt.com/docs/changelog#codex-2026-07-23-app)：项目、thread history 和 Desktop 行为的官方资料入口。
- [OpenAI Learn：配置参考](https://learn.chatgpt.com/docs/config-reference)：Codex 配置与本地目录相关资料入口。
- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)：Claude Code 本地会话行为的上游资料。
- [Claude Code Trace](https://github.com/delexw/claude-code-trace)：JSONL 会话查看、搜索和 live tail 的开源实践。
- [Codex Trace](https://github.com/PixelPaw-Labs/codex-trace)：Codex 本地会话查看实践。
- [cc-sessions-viewer](https://github.com/jerrywu001/cc-sessions-viewer)：多 CLI 会话查看和恢复实践。
- [ccusage](https://github.com/ryoppippi/ccusage)：Claude Code 本地记录聚合实践。
