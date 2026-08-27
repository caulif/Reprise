# 当前项目会话缺失：根因确认与修复方案

> 本文记录一次基于当前代码、截图和 Windows 本机 Codex 数据的定向走查。重点不是扩大扫描数量，而是解释为什么 `reprise开发` 项目及其会话仍然不可见，并给出可直接拆分实施的修复方案。

## 实施进度

- [x] 4.1 立即修正当前项目遗漏（移除 `process.cwd()` 全量排除；`excludeRoots` 改为来源路径；Codex/Claude 同规则；当前 cwd 回归；精确 ID/path 反向用例）
- [x] 4.2 精确 `excludeSessionIds` / `excludeSourcePaths` 接口（TUI 只传 `dataDir` 作为来源目录排除，并转发 `runtimeSessionIds`）
- [x] 4.3 统一 Codex 项目归属函数与 `projectKey`
- [x] 4.4 全量 catalog 不被分页和首屏掩盖
- [x] 4.5 / 9.1–9.2 extended path 与 session locator
- [x] 9.3 按可恢复性分级 Enter/freeze
- [x] 9.4 缺正文会话的可解释补救路径
- [x] 9.5 Claude 同等恢复契约
- [x] 第 5 节验收矩阵与第 10 节恢复反向用例全部落地
- [x] `npm run build` / `check` / `verify:docs`

## 1. 结论

`reprise开发` 并非不存在，也不是 Codex 没有写入索引。它被 Reprise 在发现结果合并前主动过滤掉了。

当前 TUI 调用产品会话发现时传入：

```ts
excludeRoots: [c.dataDir, process.cwd()]
```

位置：[`src/tui/controller-sessions.ts`](../../src/tui/controller-sessions.ts)。

当前进程工作目录正是：

```text
C:\Users\15893\Documents\model-test\Reprise
```

而 Codex Desktop 中该项目的正式根目录也是这个路径。因此，Codex 会话的 `cwd` 满足：

```text
pathContainedBy(process.cwd(), session.cwd) === true
```

Codex Pack 随后在两个位置都调用 `excludedCwd`：

- rollout 文件建立摘要索引时；
- SQLite/global state catalog 与 rollout 合并时。

这使得当前项目的会话在进入 TUI 之前全部消失。Claude Code 也经过同一类 `excludeRoots` 过滤，因此相同问题会影响 Claude 在当前工作目录下产生的历史会话。

## 2. 本机证据

### 2.1 Codex Desktop 确实登记了项目

`%USERPROFILE%\\.codex\\.codex-global-state.json` 中存在：

```json
{
  "id": "22056827-ace3-459d-9a31-ca4364068dcf",
  "name": "reprise开发",
  "rootPaths": [
    "C:\\Users\\15893\\Documents\\model-test\\Reprise"
  ]
}
```

`thread-project-assignments` 将当前截图对应的会话
`01a02c9a-02a2-75e1-99e6-4fffb8f5a9e7` 分配给该项目；同一项目下还存在其他分配记录。

### 2.2 当前会话在 SQLite 中存在

`%USERPROFILE%\\.codex\\state_5.sqlite` 的 `threads` 表中可查到：

```text
id: 01a02c9a-02a2-75e1-99e6-4fffb8f5a9e7
cwd: \\?\\C:\\Users\\15893\\Documents\\model-test\\Reprise
rollout_path: \\?\\C:\\Users\\15893\\.codex\\sessions\\...
```

该会话的 `project_id` 可以为空，因为 Desktop 的实际项目归属也保存在 global state 的 `thread-project-assignments`；不能只看 SQLite 这一列。

本次脱敏查询观察到：

- `threads` 中 `cwd` 位于 Reprise 根目录的记录：46 条；
- global state 分配给 `reprise开发` 的记录：30 条；
- 这些分配记录均能在 `threads` 中找到。

数量会随 Desktop 使用变化，数字只用于证明“存在一批被整体过滤的同类会话”，不能作为测试固定值。

### 2.3 截图与遗漏现象一致

截图中 Codex 侧栏显示了 `reprise开发` 项目及其会话；Reprise 不显示该项目下的对应会话。两边使用的是同一台机器上的数据，故问题发生在 Reprise 的过滤/分组链路，而不是截图中的会话尚未落盘。

## 3. 代码链路与具体缺陷

### 缺陷 A：把“扫描自身污染”错误实现成“排除当前工作目录”

当前过滤逻辑的语义是“只要会话 cwd 位于某个排除根目录下，就丢弃会话”。`process.cwd()` 是应用启动位置，不是 Reprise 自己创建的会话存储目录。把它作为排除根会删除用户在该项目中通过 Codex 或 Claude Code 创建的全部历史。

这不是单个会话的边界错误，而是按项目根目录批量删除；因此还会漏掉：

- Reprise 项目下较早的 Codex Desktop 会话；
- Reprise 项目下由子目录启动的会话；
- 当前项目中其他标题、其他模型或其他线程来源的会话；
- Claude Code 在该项目下的 transcript 和 history 合并结果。

### 缺陷 B：项目 catalog 虽被读取，但项目可能只剩“空项目”

Codex catalog 会从 global state 读取项目列表，并从 `threads` 读取会话。过滤完成后，项目仍可能作为零会话项目进入分组；但它按“无会话项目”排序，通常落在列表末尾，终端首屏看不到。若项目 key 的路径规范化与会话分组不一致，还会出现项目节点和会话节点分离的情况。

所以“项目不在首屏”和“项目没有被发现”必须分开显示；界面要提供全量计数和加载状态，不能用空项目来掩盖过滤结果。

### 缺陷 C：`cwd` 只能作为项目证据之一，不能作为排除条件

Codex Desktop 的项目归属优先来自：

1. `thread-project-assignments`；
2. `state_5.sqlite.threads.project_id`；
3. workspace root hint；
4. 经过规范化的 cwd 与项目根匹配。

当前项目的 SQLite `project_id` 为空并不表示项目外会话。若忽略 global state，就会把截图中的线程错误归入项目外；若以 cwd 做全局排除，又会把正确归属的项目整体删掉。

### 缺陷 D：来源过滤与运行时污染防护没有分层

“不要把 Reprise 自己刚刚产生的 runtime session 当作待导入历史”和“展示用户在当前项目中已有的历史会话”是两个不同问题：

- 前者按具体 session ID、source path 或显式运行上下文识别；
- 后者按 Codex/Claude 的历史索引正常发现。

用 `process.cwd()` 同时解决二者，导致安全防污染规则破坏历史完整性。

## 4. 可实施的修改方案

### 4.1 第一阶段：立即修正当前项目遗漏

1. [x] 从 [`src/tui/controller-sessions.ts`](../../src/tui/controller-sessions.ts) 传入的 `excludeRoots` 中移除 `process.cwd()`。
2. [x] 保留 `c.dataDir` 仅用于排除明确位于 Reprise 数据目录内的候选；确认其语义是“路径来源排除”，不是“会话 cwd 排除”。
3. [x] 让 Codex 与 Claude 共用同一条规则：默认不按当前工作目录过滤历史会话。
4. [x] 增加回归测试：fixture 的 `root` 为当前工作目录，至少包含一个 Codex/Claude 会话；首次 discovery 必须返回该会话。
5. [x] 增加反向测试：只有明确列入 `excludedSessionIds` 或 `excludedSourcePaths` 的 Reprise 自身运行会话才被排除；同 cwd 的普通历史会话必须保留。

这一步应先做，因为不修它，后续 catalog、全量分页和项目归属优化都会在 TUI 入口被统一删除。

### 4.2 第二阶段：把排除接口改成精确排除

将当前宽泛的 `excludeRoots` 拆成明确字段，建议保持最小协议：

```ts
type SessionDiscoveryQuery = {
  // ...已有字段
  readonly excludeSessionIds?: readonly string[];
  readonly excludeSourcePaths?: readonly string[];
};
```

规则：

- [x] `excludeSessionIds` 精确匹配产品内 session ID；
- [x] `excludeSourcePaths` 在规范化、校验位于允许根目录后精确匹配文件；
- [x] 不允许默认把 `process.cwd()` 转换成全量 cwd 排除条件；
- [x] 若确实需要目录排除，只能由显式调用方传入，并在调用点写出“排除该目录内所有历史”的产品语义。

运行时应在创建会话时记录 Reprise 发起的 session ID，运行结束后将该 ID 作为一次性排除项传给 discovery，而不是依据工作目录猜测。TUI 已预留 `runtimeSessionIds` 并在 discovery 时转发；候选运行写入该列表仍待实验层补齐原生 session ID。

### 4.3 第三阶段：建立统一的 Codex 项目归属函数

新增一个产品内 helper，输入 thread 行、global state assignment、workspace hint、rollout metadata，输出：

```ts
{
  projectId?: string;
  projectRoot?: string;
  classification: 'project' | 'projectless' | 'unknown';
  evidence: 'assignment' | 'sqlite-project-id' | 'workspace-hint' | 'cwd' | 'explicit-projectless' | 'none';
}
```

约束：

- [x] assignment 优先于 SQLite `project_id`；冲突产生诊断但不丢弃会话；
- [x] assignment 指向未知项目时保留会话并标记 unknown，不静默删除；
- [x] `projectless-thread-ids` 明确进入“项目外会话”；
- [x] catalog-only thread 仍显示，正文不可读只改变 availability；
- [x] rollout-only thread 仍显示，不能因没有 Desktop assignment 而丢失；
- [x] 仅用 cwd 匹配已知项目根时，必须使用与 TUI 相同的 Windows 路径规范化函数。

项目 key 应由同一个 `projectKey(productId, canonicalRoot)` 生成。不要在 Codex adapter 中手写一套 key，再在 TUI 中用另一套字符串拼接。已收口为 [`sessionProjectKey`](../../src/products/shared/session-project.ts)。

### 4.4 第四阶段：确保全量 catalog 不被分页和首屏掩盖

发现层返回完整轻量 catalog；TUI 保存全部项目和会话，只对终端 viewport 截取绘制行。`m` 可以保留为兼容键，但不能再触发“发现更多”。

同时增加以下 UI 语义：

- [x] 顶部显示 `项目数 / 会话数 / 项目外会话数 / 不可读数`；
- [x] catalog 正在读取时显示明确的 loading 状态；
- [x] 空项目仍可见，但显示 `0 个会话`；
- [x] 项目外会话固定为一个显式节点；
- [x] 搜索、排序、计数在全量 catalog 上执行，而不是只对 viewport 或首批结果执行；
- [x] 首屏没有目标项目时，状态栏显示“已加载 N 个项目、M 个会话”，避免把“在末尾”误认为“未扫描”。

对 Codex，应继续以 `state_5.sqlite` + `.codex-global-state.json` 作为轻量目录来源，以 rollout JSONL 作为可选正文来源；对 Claude，应以 transcript/history 建立同样的全量目录。启动阶段不需要读取全部正文。

### 4.5 第五阶段：处理路径与文件来源的次级缺口

当前本机 `rollout_path` 可能带 `\\?\\` Windows extended prefix。实现必须在比较、存在性检查和读取前统一路径规范化，并验证：

- [x] `\\?\\C:\\...` 与 `C:\\...` 视为同一文件；
- [x] 规范化后仍位于 sessions root（`pathContainedBy`，不以 `relative` 返回绝对路径作为唯一越界依据）；
- [x] 不接受越界路径、重解析点或符号链接逃逸；
- [x] DB 有 thread 但 rollout 丢失时保留 catalog-only；
- [x] rollout 有但 DB 无时保留 rollout-only；
- [x] 任何失败都有 diagnostics，不把失败候选从 `items` 中静默删除。

这部分不能替代第一阶段修复：即使 extended path 全部正确，`process.cwd()` 过滤仍会删除当前项目会话。

## 5. 验收矩阵

| 场景 | 期望结果 |
|---|---|
| Codex thread 的 cwd 等于当前 Reprise 根目录 | 出现在 `reprise开发` 项目下 |
| Codex thread `project_id` 为空，但 global assignment 指向 `reprise开发` | 出现在 `reprise开发` 项目下 |
| 多个不同标题、同一项目根的 thread | 全部保留，不按标题去重 |
| Claude transcript cwd 等于当前 Reprise 根目录 | 出现在该项目下 |
| 没有项目 assignment 的有效 thread | 出现在“项目外会话” |
| 只有 SQLite catalog、rollout 文件缺失 | 显示为 catalog-only/source-missing |
| 只有 rollout、没有 SQLite 索引 | 显示为 rollout-only/unindexed |
| 151 个会话首次发现 | 一次返回 151 个，未按 `m` 才出现 |
| 当前工作目录改变 | 不改变历史发现范围 |
| 明确排除的 Reprise runtime session | 只排除指定 ID/path，不影响同项目其他会话 |
| 损坏 JSONL、锁定 DB、越界路径 | 保留可解释 diagnostics，不导致其他会话消失 |

建议将本机数据转换为脱敏 fixture，仅保留路径类别、项目 ID、thread ID 形态、时间和摘要占位符；不要把真实会话正文、凭据或完整数据库提交到仓库。

## 6. 实施顺序与门禁

实施顺序必须是：

1. 移除 TUI 的 `process.cwd()` 全量排除；
2. 添加当前项目/同 cwd 会话的 Codex、Claude 回归测试；
3. 拆分精确 session ID/path 排除接口；
4. 统一 project key 与归属证据优先级；
5. 完善全量 catalog 的计数、空项目和 viewport 展示；
6. 补充 extended path、source-missing、rollout-only 和 diagnostics fixture。

修改源码后按仓库门禁执行：

```powershell
npm run build
npm run check
npm run verify:docs
```

本方案只涉及文档记录，不读取或复制任何本机凭据，不要求联网或启动真实 Agent Runtime。实现时必须继续保持 Codex/Claude 数据只读，不能修改、迁移或删除 Desktop 数据。

## 7. 相关代码入口

- [`src/tui/controller-sessions.ts`](../../src/tui/controller-sessions.ts)：TUI 传入会话排除条件的入口。
- [`src/products/codex/sessions.ts`](../../src/products/codex/sessions.ts)：Codex rollout 与 catalog 合并、`excludedCwd`。
- [`src/products/codex/catalog.ts`](../../src/products/codex/catalog.ts)：SQLite thread 与项目 assignment 合并。
- [`src/products/codex/global-state.ts`](../../src/products/codex/global-state.ts)：项目、assignment、projectless 集合读取。
- [`src/products/claude-code/sessions.ts`](../../src/products/claude-code/sessions.ts)：Claude transcript/history 发现与 cwd 排除。
- [`src/tui/pages/intake.ts`](../../src/tui/pages/intake.ts)：项目分组、项目外会话和项目 key。

## 8. 截图中的“无法继续”为什么发生

截图中的英文提示来自 [`src/tui/controller-run.ts`](../../src/tui/controller-run.ts) 的保护分支：

```ts
if (session?.availability === 'catalog-only') {
  throw new Error('Selected session has catalog metadata but no readable transcript.');
}
```

这不是恢复模块本身拒绝了一个可读 transcript，而是列表中的会话被标记成了 `catalog-only`。当前实现把该状态统一当作“没有可读取正文”，因此 Enter 不会继续进入 freeze/import。

对本机这个案例，`catalog-only` 的形成有两个叠加原因：

1. `process.cwd()` 过滤掉了 Reprise 项目下的 rollout；
2. Codex Desktop 的 `rollout_path` 带有 `\\?\\` extended-length 前缀，而 [`src/products/codex/catalog.ts`](../../src/products/codex/catalog.ts) 的 `safeRolloutPath` 直接把它交给 `path.relative`，再把返回的绝对 extended path 判定为越界。其 `realpathSync` 校验还会在 Windows 出现 `EISDIR: illegal operation on a directory, lstat 'C:'` 一类错误。

本机检查显示 `state_5.sqlite` 的 1,360 条 thread 均有 rollout path，去掉 `\\?\\` 前缀后对应文件均存在。换句话说，截图对应的这类条目不能简单归因于“Codex transcript 已删除”；当前代码存在路径解析误判。由于当前项目的 rollout 又先被 cwd 规则排除，合并层无法用可读 rollout 覆盖 catalog-only 状态，最终触发了截图中的提示。

因此，“所有会话都应该可以恢复”需要拆成两个可验证目标：

- **所有有可读 transcript 的会话都必须可恢复**，无论它来自 SQLite catalog、rollout 文件还是二者的合并；
- 真正只有目录元数据、正文已删除/损坏/无权限的会话不能凭空恢复正文，但必须保留、明确标注原因，并提供重扫或诊断路径，不能伪装成不存在。

## 9. 恢复能力修复计划

### 9.1 先修复可读源被误判的问题

1. 先按第 4.1 节移除 `process.cwd()` 的默认历史排除。
2. 在 Codex catalog 中加入 Windows extended path 规范化：读取 DB 字符串后先转换 `\\?\\C:\\...`、`\\?\\UNC\\...` 到统一内部形式，再做 `resolve`、`relative`、`realpath` 和文件存在性检查。
3. 不用“`relative` 返回绝对路径”作为越界判断的唯一依据；先判断输入是否为绝对路径，再用规范化后的绝对路径验证它是否位于 sessions root。
4. 使用一个已有的路径安全 helper 或新增一个小型 Codex locator helper，保证列目录、SQLite catalog、inspect、import 使用同一规范化结果。
5. 对目录边界、大小写、分隔符、extended prefix、UNC 路径和重解析点分别增加 fixture。

修复后，对截图中的 session 应满足：

```text
availability = indexed
sourceKind = catalog+transcript
sourcePath = 实际存在的 rollout JSONL
```

Enter 应进入 inspect/freeze，而不是触发 catalog-only 保护分支。

### 9.2 建立“按 session ID 找正文”的可靠 locator

不能只相信 SQLite 的 `rollout_path` 字符串，也不能只依赖一次 JSONL 扫描结果。Codex discovery 应在同一快照中建立：

```text
sessionId -> verified rollout path
```

候选优先级：

1. rollout 目录扫描中解析出的合法 `session_meta.id` 与实际文件；
2. SQLite `rollout_path` 经规范化并通过 root containment、普通文件和可读性检查后的路径；
3. 仅有 catalog 元数据的条目，标记为 source-missing，不生成伪造 `.catalog/<id>.jsonl` 作为可恢复源。

合并规则：

- 同 ID 的多个文件选择经过校验且更新时间最新者，同时记录 duplicate diagnostic；
- DB 路径和扫描路径指向不同文件时，不丢弃会话，保留冲突诊断并优先使用能解析出同一 ID 的文件；
- 文件名中的 UUID 不能单独作为 session ID 证据，必须读取 `session_meta`；
- locator 失败不能删除 catalog row。

这样可以覆盖“DB 有路径但路径格式不同”“DB 路径过期但 rollout 仍在目录中”“rollout-only 未进入 Desktop catalog”等情况。

### 9.3 让恢复入口按可恢复性处理，而不是按来源类型一刀切

`catalog-only` 保护分支保留其数据安全目的：没有经过验证的正文，不能执行 freeze。需要改成明确的能力分级：

| 条件 | 列表状态 | Enter 行为 |
|---|---|---|
| rollout 存在、可读、session ID 一致 | `indexed` / `catalog+transcript` | 允许 inspect、选择输入、freeze |
| rollout 路径可定位但摘要读取失败 | `unreadable` | 显示失败原因，提供重新读取；不静默消失 |
| catalog 存在、正文文件确实缺失 | `catalog-only` | 显示“正文缺失”，禁用 freeze，允许查看诊断和重扫 |
| rollout 存在但不在 SQLite | `unindexed` / `rollout-only` | 允许 inspect、freeze，并归入正确项目或项目外 |
| 正文 JSONL 损坏 | `unreadable` | 保留条目；禁止把损坏内容当作可恢复 transcript |

恢复前再次执行一次 `stat`、大小上限检查、JSONL 解析和 session ID 校验，避免列表建立后文件被删除或替换造成错误恢复。

### 9.4 对真正缺正文的会话提供可解释的补救路径

“所有会话可恢复”不能通过伪造正文实现。对真正没有 rollout 的 catalog-only thread，应提供：

- 显示 thread ID、项目、创建/更新时间、正文来源状态；
- 显示缺失原因：文件不存在、路径越界、无权限、JSONL 损坏或超出安全读取限制；
- `r`/刷新重新扫描，但刷新不能改变项目外和项目归属；
- 将诊断写入内存状态或安全报告，不输出正文和凭据；
- 若 `thread_history_1.sqlite` 能提供完整且可验证的消息投影，单独设计 Codex history import 适配器后再支持恢复；不能把 Desktop history projection 自动当成 rollout 原文；
- 没有完整用户输入、assistant/tool 记录和必要元数据时，只能查看索引，不能创建历史 TaskCase。

### 9.5 Claude Code 使用同等恢复契约

Claude 不使用 Codex SQLite，但恢复问题同样可能来自 transcript 删除、history-only 记录、路径不可读、JSONL 损坏和 cwd 过滤。Claude Pack 应：

- transcript 与 `history.jsonl` 按真实 session ID 合并；
- history-only 保留为索引条目并明确不可恢复正文；
- transcript 可读时不因 history 中字段不全而降级为不可恢复；
- 统一使用精确 source path/session ID 排除，不能按 `process.cwd()` 删除整个项目；
- inspect/import 前重新校验文件存在性和 session ID。

## 10. 恢复专项验收

除第 5 节验收矩阵外，增加以下反向用例：

1. 给 SQLite thread 写入 `\\?\\C:\\...` rollout path，实际 rollout 文件存在；首次 discovery 后 Enter 必须能够 inspect/freeze。
2. 同一 thread 的 DB path 不可用，但 sessions 目录中存在包含相同 `session_meta.id` 的文件；必须通过 locator 恢复。
3. 当前工作目录与项目根相同，仍有可读 Codex/Claude transcript；不能被排除。
4. 只有 catalog、没有正文；条目必须可见，但 freeze 必须明确阻止并显示 source-missing。
5. 正文在列表后删除；Enter 必须显示 unreadable/source-missing，而不是崩溃或恢复错误内容。
6. JSONL 的 session ID 与文件名不一致；必须按正文 metadata 判断，不能错误合并。
7. 具有同名/同 cwd 的多个会话；全部可见且可分别恢复。
8. rollout-only、catalog-only、catalog+transcript 三类条目的项目分组和恢复动作符合同一契约。

建议使用脱敏 fixture 验证这些场景，不把本机 SQLite、真实 rollout 正文或任何凭据复制进仓库。
