# Claude Code Pack 实现规划（含共享契约设计）

> 状态：Step A–E 已落地；Step F 真机验收与端到端报告叙事阻塞于账户欠费。2026-08-13 定稿，2026-08-14 按契约评审结论与真机 spike 结果重写。
> 本文是**自足文档**：实现 Claude Code Pack 所需的全部内容都在这里，包含它依赖的共享契约设计与 Codex 解耦工作。
> 范围：**只覆盖 Codex（既有）与 Claude Code（新增）两个产品**。dsh 不在范围内；契约满足"第三个产品接入时不需要破坏性修改"，但**不为它预置任何字段**（推迟项在 5.6 逐条列出）。
> 相关文档：`docs/architecture/overview.md` §6 与 `docs/architecture/product-plugin-compatibility.md` 是契约的**架构基线，本文服从它们**；`docs/plan/second-product-packs-claude-code-dsh.md` 是三产品全景（本文与它的分歧见其头部说明）。
> 事实来源：本机实测。Claude Code v2.1.221；`~/.claude/projects/` 下 30 个真实会话、2628 行、9 个项目；**两次真机 spike**（含一次真实回合尝试）。实测脚本在 `%TEMP%\reprise-claude-*.mjs`，可复跑。

---

## 1. 为什么这份规划必须包含契约设计

Claude Code 不能"加一个目录"就接进来。当前的 Codex 支持**不是插件，是纵切片**：

```text
src/tui/          138 处 codex 字面量 / 104 行 / 11 个文件
  controller.ts 34   timeline.ts 18   view-projection.ts 10   i18n.ts 9
  intake.ts 8        run.ts 8         result.ts 7             workbench.ts 7
```

"是不是插件"的判据不是能否热加载（你的架构明确不做动态加载：`technology-selection.md:44`、`overview.md:428`），而是**依赖方向**：核心不认识任何具体产品，产品只依赖契约。按此判据实测，`src/core` 是干净的（无 `products` 引用），但外层有 **5 处绕过注册表直接伸进 Codex 包内部**：

| 位置 | 引入的东西 | 性质 |
|---|---|---|
| `src/cli/main.ts:4` | `CodexRuntimePort` | 类实现 |
| `src/tui/controller.ts:43` | `products/codex/sessions.js` | 函数实现 |
| `src/application/codex-experiment.ts:65` | `codexProductPack` | Pack 实例 |
| `src/tui/view-projection.ts:4` | `CodexSessionInspection` / `Privacy` / `Summary` | **类型层耦合** |
| `src/tui/pages/intake.ts:2` | 同上 | **类型层耦合** |

最后两处最要紧：**TUI 的视图模型就是按 Codex 的类型写的**。不处理它，加 Claude 只能得到联合类型或第二套视图模型，TUI 的类型会变成"已安装产品集合"的函数，插件化在结构上就破了。

不先建立契约就加 Claude，还会让 `src/tui/timeline.ts` 的 `switch` 从 11 个 `case 'codex.*'` 变成 22 个，两套标签文案由两次独立编写产生。**这会直接摧毁产品价值**：Reprise 的产出是"同一任务在两个 agent 上的行为差异"，若 UI 对同一件事呈现不同，读者无法区分行为差异与渲染差异。

### 1.1 核心原则

1. **TUI 拥有全部展示逻辑与展示词汇。** 条目结构、来源分类、流式合并语义、标签文案、告警等级全部由 TUI 定义，TUI 代码里不出现产品名。
2. **Pack 只做翻译，不做展示。** Pack 回答"这件事属于哪一类活动"，不回答"长什么样"。
3. **一切产品适配都通过 Pack**，没有后门通道。
4. **产品无关的基础设施不得进入 Pack。** 冻结机制、崩溃一致性、脱敏都是共享设施；让每个 Pack 各抄一份就是把核心代码塞进插件（这是本次评审改掉的最大缺陷，见 5.2）。
5. **同一件事在两个产品里读起来一样。**

### 1.2 不做什么

- 不做插件热加载 / 插件市场 / 目录扫描 / 动态执行——继续**静态注册**。
- 不重写 `CandidateRun` / `Comparison` / `LocalWorkspaceProvider`。
- 不管理 Claude Code 的内部配置：**前提是用户先把 `claude` 配好，Reprise 只读取与使用**，不写入、不代为登录。
- 不改 `src/core/schema.ts`（本次无预期的领域 schema 改动）。

---

## 2. 现状盘点（实测行号）

| 层 | 现状 | 处置 |
|---|---|---|
| `RuntimePort` / `TargetRunner`（`src/core/runtime.ts:48-71`） | 稳定，Codex 完整实现 | **直接复用** |
| `TaskCase` / `RunRecord`（`src/core/schema.ts`） | 产品无关 | **不动** |
| `CodexPack` 类型（`src/products/codex/pack.ts:46-55`） | 三个成员：`runtime`、`recoveryPlaybook()`、`manifest`；`productId: 'codex'` 与 `packVersion: '0.1.0'` 是**字面量类型** | **删除该专属类型**，改为通用 `ProductPack` |
| 会话发现/冻结 | `src/products/codex/sessions.ts` 中解析与冻结**混在一起** | 拆：解析入 Pack，冻结上提共享（5.2） |
| TUI 展示词汇 | `TimelineEntry` / `TimelineSource` / `itemId`+`patch` 合并语义已产品无关（`timeline.ts:7-48`） | **保留为 TUI 资产** |
| TUI 事件映射 | 11 个 `codex.*` 分支（135–157）、`'Codex is running this turn.'`（138）、`itemId: 'codex-tokens'`（273）、`isPlaceholder()` 比对 `'Codex is writing a reply.'` 字面量（566） | 全部清除 |
| `productPacks` 注册表 | `[codexProductPack] as const`，CLI/TUI 不消费 | 改 `readonly ProductPack[]` + 按 id 查找 |
| CLI composition root | `main.ts`：4–6 行直接 import Codex 三件套、60 行帮助文本写死、79 行默认路径写死 `CODEX_HOME`、**92 行 `new CodexRuntimePort({ effort: 'high' })`** | 改为消费注册表 |
| 实验编排守卫 | `codex-experiment.ts:392,442` 两处 `productId !== "codex"` 抛错 | 放宽 |
| 实验编排事件解析 | 同文件 1028、1050、1071–1072 行直接解析 `codex.item_completed` / `codex.server_request_rejected` | 下沉到 Pack |
| 默认候选 | `codex-tui-workflow.ts:10` 写死 Codex | 由所选 Pack 提供 |
| `RuntimeAvailability` | 架构定义了 `status` / `installHint`（`product-plugin-compatibility.md:76-83`），代码 `inspectAvailable()` 找不到只返回 `[]` | 补齐（本轮纳入） |
| 产品名文件 | `tui/codex-intake.ts`、`application/codex-experiment.ts`、`codex-tui-workflow.ts` | 更名，末尾一次性做 |
| 环境/对比/报告 | 产品无关 | **不动** |

---

## 3. 两产品同构性与差异

```text
本地历史会话文件（JSONL，含 cwd）          → SessionSourceAdapter
子进程 + 行式 JSON 协议的编程控制面        → RuntimePort / TargetRunner
  Codex:       app-server JSON-RPC
  Claude Code: CLI 双向 stream-json
产品私有事件 → TUI 拥有的活动词汇          → Pack 内 translator
```

| 维度 | Codex | Claude Code | 契约影响 |
|---|---|---|---|
| 会话位置 | `CODEX_HOME/sessions/**/rollout-*.jsonl` | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | adapter 各自持默认根 |
| 会话元数据 | 首行 `session_meta` 集中 | **无首行元数据**，分散在每条消息行 | `import()` 不能假设"首行是元数据" |
| 回合完成信号 | `task_complete` 事件 | assistant 的 `stop_reason === 'end_turn'` | `signals.completedTurns` 语义按产品定义 |
| 控制协议 | JSON-RPC（`id` + `result`/`error`） | NDJSON + `control_request`/`control_response`（`request_id` 配对，无 `jsonrpc` 字段） | **协议客户端不共享**（10.6） |
| 模型目录 | `model/list` RPC → `{ id, model }` | `initialize` 控制请求 → `{ value, resolvedModel }` | **同构**，`validateCandidate` 同写法 |
| 目录 vs 可用性 | 未验证 | **实测：目录通过、真实调用 403**（6.4） | 报告必须区分"目录已列出"与"确实可跑" |
| 入队回执 | RPC 响应 | `--replay-user-messages` 回显且**保留客户端 uuid**（实测） | 两者都能 `nativeAdmission: true` |
| 无人值守开关 | sandbox 参数 | 启动参数（`--permission-mode` + 不传 `--permission-prompt-tool`） | 契约不统一，只要求 preflight 能报告 |
| 终止能力 | 杀进程 | 杀进程；另有 `interrupt_receipt_v1` 能力（实测 init 报出） | `stop` 以进程终止为最终手段 |
| 登录探测 | Codex 自身登录态 | init 的 `apiKeySource` / `initialize` 的 `account` | 提升为 `checkAuth()` |
| recovery playbook | 有（`products/codex/recovery/SKILL.md`） | **要写**（材料来自 15 节实测坑表） | 契约**必选**（5.5） |

---

## 4. 已定的架构基线（本文服从）

来自 `docs/architecture/overview.md` §6 与 `product-plugin-compatibility.md`，本次评审确认这些是对的、本文早前版本违反过它们：

1. **`SessionSourceAdapter` 只有 `discover` 与 `import`**，产出产品无关的 `ImportedSession`（`overview.md:390-393`）。冻结成 `TaskCase` 是 Case Preparation 的职责，不是 Pack 的。
2. **`recoveryPlaybook` 是 Pack 的必选成员**（`overview.md:374`）；Pack 被定义为"确定性代码和版本化知识作为一个不可拆分的包"，pack 与 playbook 的 hash 写入 provenance 以防静默漂移。
3. **Manifest 不声明历史 Runtime 版本矩阵**（`product-plugin-compatibility.md:57`）：兼容性由固定 fixtures + 契约测试 + 可选本机 smoke 验证，"不用一个宽泛版本范围假装兼容"。→ 本文早前提的 `verifiedRuntimeVersions` **已删除**。
4. **`manifest.productId` 是 `string`**，不是字面量类型（`product-plugin-compatibility.md:44`）。
5. **两类 Runtime 事实分离**：`SourceRuntimeEvidence`（解释历史）与 `ExecutionRuntimeFingerprint`（本次执行，含 `observableConfig` 与 `configHash`）。版本事实属于**每次运行**，不属于 Pack 声明。
6. **Pack 不提供 Controller / Comparison 的产品专属策略**，不能改核心状态机、放宽隔离、安装 Runtime、自行决定 fidelity。

---

## 5. 共享契约设计

放在 `src/products/contract.ts`（契约属于产品接入层，不进 `src/core`）。

### 5.1 Pack 契约

```ts
export interface ProductPack {
  readonly manifest: ProductPackManifest;      // productId: string, displayName, packVersion, schemaVersion,
                                               // sessionSchemaVersions?  —— 不含版本矩阵（§4.3）
  readonly sessions: SessionSourceAdapter;     // 新增：只发现与导入，不冻结
  readonly runtime: RuntimePort;               // 既有接口
  readonly activity: TargetActivityTranslator; // 新增：私有事件 → TUI 活动词汇
  recoveryPlaybook(): RecoveryPlaybookDescriptor; // 必选（§4.2）
  checkAuth(): Promise<ProductAuthStatus>;     // 新增：凭据探测（只读、不落密钥）
}
```

`CodexPack` 这个专属类型删除；两个 Pack 都只是 `ProductPack`。注册表改为 `readonly ProductPack[]` 加按 id 查找，未知 id 有清晰报错。

`recoveryPlaybook` 的返回形状要在**代码的 `RecoveryPlaybookDescriptor { version, sha256, text }`**（`pack.ts:44`，直接读文件内容）与**架构文档的 `RecoveryPlaybookRef { path, version, contentHash }`**（`overview.md:384`）之间选一个并同步另一方。建议保留代码现状（`text` 已在手，Recovery Agent 直接可用），文档改为与代码一致。

### 5.2 会话导入：Pack 不做冻结（本次最大修正）

```ts
export interface SessionSourceAdapter {
  discover(query?: SessionDiscoveryQuery): Promise<readonly SessionSummary[]>;
  inspect(ref: SessionRef): Promise<SessionInspection>;   // 冻结前的检查视图
  import(ref: SessionRef): Promise<ImportedSession>;      // 产品无关快照 + diagnostics
}
```

**冻结不在契约里。** 暂存目录、原子 rename、内容哈希、幂等复用、崩溃残留清理、脱敏先于写入——全部是产品无关的崩溃一致性基础设施，由共享的 `freezeCase(imported, casesRoot, privacy, now)` 承担一次。

为什么这是本次最重要的修正：把 `freeze()` 放进 Pack 契约，等于每接一个产品复制一份冻结机制，第三个产品就是第三份，修一个暂存 bug 要修 N 处。这与原则 1.1.4 直接冲突，也与架构基线 §4.1 冲突。

落地方式：Codex 现有的 `freezeCodexSession`（`sessions.ts:132-163`）按这条线拆开——解析与 `TaskCase` 字段构造留在 Pack（产出 `ImportedSession`），staging/rename/幂等/脱敏上提。**这是行为不变的重构**，安全网是既有的两条测试：`Codex rollout discovery and freeze are read-only, complete, redacted, and idempotent` 与暂存写失败可重试那条（`test/codex-pack.test.ts`）。以它们零 diff 为准绳。

### 5.3 产品无关的会话类型

契约提供 `SessionSummary` / `SessionInspection` / `SessionPrivacy` / `SessionRef` / `ImportedSession`，字段以 Codex 现有的 `CodexSessionSummary` / `CodexSessionInspection` / `CodexSessionPrivacy` 为基准归纳（`sessionId` / `sourcePath` / `startedAt` / `cwd?` / `model?` / `summary?` / `signals`），Claude 侧完全对得上。

Codex 的三个类型改为契约类型的别名或直接删除。**TUI 只 import 契约类型**——`view-projection.ts` 与 `pages/intake.ts` 现在的 Codex 类型 import 必须消失，验收用 grep 断言。

### 5.4 展示分工：TUI 拥有词汇，Pack 只做翻译

`timeline.ts` 已有的 `TimelineEntry` / `TimelineSource` / `itemId`+`patch` 合并语义保留不动。新增 TUI 定义的活动词汇作为翻译目标：

```ts
/** TUI 拥有的封闭活动词汇。Pack 只能从中选择，不能自造类别。 */
export type TargetActivity =
  | { kind: 'prompt'; text: string }
  | { kind: 'thinking'; text?: string; streaming?: true }
  | { kind: 'message'; text?: string; streaming?: true }
  | { kind: 'command'; command: string; status: 'started' | 'completed' | 'failed';
      output?: string; cwd?: string; exitCode?: number; durationMs?: number; blockedBySandbox?: true }
  | { kind: 'file_change'; changes: readonly FileChange[] }
  | { kind: 'web_search'; query?: string; completed: boolean }
  | { kind: 'tool_call'; name: string; status: 'started' | 'completed' | 'failed'; body?: string }
  | { kind: 'plan'; steps: readonly { status: string; step: string }[] }
  | { kind: 'token_usage'; total: number; input?: number; output?: number; reasoning?: number; cached?: number }
  | { kind: 'sandbox_notice'; label: string; identity?: string; caveat?: string }
  | { kind: 'runtime_error'; message: string }
  /** 逃生口：值得展示但不属于任何已有类别。TUI 用通用样式渲染，不得成为常态。 */
  | { kind: 'other'; label: string; body?: string };

export interface TargetActivityTranslator {
  /** 只处理本 Pack 命名空间的事件；返回空数组表示"仅留在 trace 里，不上时间线"。 */
  translate(event: EventEnvelope): readonly TargetActivityEntry[];
}

export type TargetActivityEntry = {
  activity: TargetActivity;
  /** 同一逻辑条目的稳定 id（流式增量合并用），Pack 负责其在本产品内唯一。 */
  correlationId?: string;
  merge?: 'replace' | 'append';
};
```

四条约束：

1. **Pack 不产出 title / detail / level。** 文案与等级由 TUI 从 `kind` 与字段推导——Pack 没有能力通过自己写文案产生差异。
2. **`kind` 是封闭集合。** 新增类别要改 TUI，属于有意的摩擦。**已知代价**：Claude 有 26 个内置工具（实测，6.5），只有约 11 个能落进现有类别，其余会进 `other`。这一点在 Step D 会被量化，若阈值不过就回改词汇，而不是让 Claude 将就。
3. **翻译只覆盖本 Pack 命名空间**（`codex.*` / `claude.*`）。`run.*` / `controller.*` / `comparison.*` / `runtime.*` 等领域事件继续由 TUI 自己投影。
4. **未知事件降级为丢弃**，不得抛错。

顺带修掉 `isPlaceholder()`（`timeline.ts:566`）靠比对 `'Codex is writing a reply.'` 字面量驱动合并的缺陷——改为由活动的 `streaming?: true` 派生 placeholder 标志。

### 5.5 recoveryPlaybook 必选，Claude 也要写

架构基线 §4.2 要求必选。早前版本改成可选、理由是"Claude 没跑过真机实验，凭空写就是编造"——**这个理由不成立**：第 15 节那张表里已有十余条实测失败模式（stdin EPIPE 崩宿主、缺 `--verbose` 直接退出、`subtype: success` 与 `is_error: true` 并存、账户欠费的 403、候选运行污染 `~/.claude/projects`），这些本身就是 recovery 知识。

`src/products/claude-code/recovery/SKILL.md` 的内容来源：15 节实测坑表 + spike 观测到的帧序列（用于判断"卡在哪一步"）。

### 5.6 只有两个产品时的裁剪决定

上游契约是从三个产品归纳的，若干设计由 dsh 单独驱动。逐条重判：

| 上游设计 | 原始动机（dsh） | 两产品下的判断 |
|---|---|---|
| 验证强度字段（`catalog`/`probe`/`declared`） | dsh 无目录，只能"声明即接受" | **推迟**，但**理由已变**：spike 证明 Claude 的目录校验**不等于可用性**（6.4），所以真正需要的区分不是 `catalog` vs `declared`，而是"目录已列出" vs "确实跑通过"。这件事先用报告文案与 `ExecutionRuntimeFingerprint` 如实表达，不急着加 schema 字段 |
| `SessionSourceAdapter` 不假设纯文本可流式读 | dsh 是 zstd | **接口保持最简**：两产品都是本地明文 JSONL |
| 状态栏聚合 pill | 三个 login pill 挤爆窄终端 | **先保留 per-product pill**：两产品是 5 个 pill，触发聚合的前提不成立；以 Step A 的帧为准校对 |
| `stop` 以进程终止为最终手段 | dsh 无 wire cancel | **保留**：两产品都能可靠杀进程，本来就该这样 |
| `--sessions-dir` 改可重复 `<productId>=<path>` | 三产品各有默认根 | **保留**：两产品同样各有默认根，且现有帮助文本（`main.ts:60`）已是 Codex 专属 |
| 跨产品重放：契约解耦、UI 仅同产品 | 三产品重放矩阵 | **保留**：解耦不花成本，UI 先只暴露同产品 |
| `CandidateSpec` 增加 provider 维度 | dsh 候选含 provider | **不需要**，`src/core/schema.ts` 保持不动 |

约束：以上推迟项必须是**加法可扩展**的。若 dsh 落地时发现只能靠破坏性修改引入，说明这里判断错了，届时记 ADR。

---

## 6. Claude Code 实测事实基线

### 6.1 会话文件（30 文件 / 2628 行 / 0 行无法解析）

顶层 `type` 共 13 种：`assistant`(1047)、`user`(622)、`attachment`(165)、`last-prompt`(165)、`mode`/`permission-mode`(各 135)、`ai-title`(67)、`system`(63)、`file-history-snapshot`(61)、`file-history-delta`(50)、`custom-title`/`agent-name`(各 42)、`queue-operation`(34)。

`system` 的 `subtype`：`turn_duration`(43)、`away_summary`(15)、`local_command`(4)、**`compact_boundary`(1)**。

`message` 层字段：`user` **只有 `content` 和 `role`**；`assistant` 有 `content` `role` `model` `usage` `stop_reason` `stop_details` `stop_sequence` `id` `type` `container` `context_management`。

content block：

| 位置 | block | 计数 | 字段 |
|---|---|---|---|
| assistant | `tool_use` | 532 | `type,id,name,input` |
| user | `tool_result` | 532 | `tool_use_id,type,content,is_error` |
| assistant | `thinking` | 290 | `type,thinking,signature` |
| assistant | `text` | 225 | `type,text` |
| user | **纯字符串** | 90 | content 直接是 string |

`stop_reason`：`tool_use` 918、`end_turn` 55、`stop_sequence` 26、`max_tokens` 7。

### 6.2 三条与直觉相反的事实

**(1) 工具结果也是 `type: 'user'` 行。** 622 条里 532 条是 `tool_result`，真实用户输入只有 90 条。判据：content 为纯字符串或含 `text` block，**且不含 `tool_result` block**，且 `isMeta` / `isCompactSummary` / `isVisibleInTranscriptOnly` / `isSidechain` 均不为 `true`。按此判据 30/30 文件都能正确取到初始输入。

**(2) 真实用户输入在本机语料里 100% 是纯字符串**（`textBlock=0`）。但 SDK 类型允许 block 数组，两种都要处理。

**(3) `sessionId` 与 `session_id` 不是同一个东西。** 同时出现时有 41 处取值不同；`sessionId` 与文件名 uuid 完全一致（2517 行 0 处不符）。**只用 `sessionId`，永不读 `session_id`。**

**`stop_reason: 'stop_sequence'` 不可信**：spike 中一次 403 认证失败也报了 `stop_sequence`（6.4）。历史语料里 `stop_sequence` 有 26 条、`<synthetic>` 模型也正好 26 条、`isApiErrorMessage: true` 同为 26 条——三者同数，说明那 26 条是 API 错误而非真的命中停止序列。因此 `completedTurns` 只认 `end_turn`。

### 6.3 控制面（零 token 实测）

`claude -p --input-format stream-json --output-format stream-json --verbose`，只发控制请求不发 user 消息：

- `initialize` 控制请求**冷启 915ms、二次 880ms**，进程随后干净退出 0。
- `models` 是真实目录，4 条，字段 `value` `displayName` `resolvedModel` `description` `supportedEffortLevels` `supportsEffort` `supportsAutoMode` `supportsAdaptiveThinking`：

```text
value=default  resolvedModel=Default (recommended)  「currently Fable 5」
value=opus     resolvedModel=claude-fable-5         「Custom Opus model (1M context)」
value=sonnet   resolvedModel=claude-fable-5         「Custom Sonnet model (1M context)」
value=haiku    resolvedModel=claude-fable-5         「Custom Haiku model」
```

`value` 是传给 `--model` 的别名，`resolvedModel` 是实际解析结果——与 Codex `{ id, model }` 同构，`validateCandidate` 可同写法。

- `account` 只有 `{ apiProvider, tokenSource }`。
- `claude --version` → `2.1.221 (Claude Code)`；可执行文件是 bun 编译的 native exe（`~/.local/bin/claude.exe`），同时存在 npm shim `.cmd`。
- **所有别名都指向同一个 `claude-fable-5`**，且描述是 "Custom ... model"。选不同别名跑的是同一模型，报告不应暗示比较了不同模型。

### 6.4 真机 spike：一次真实回合尝试

隔离 temp 目录作 cwd，参数为 6.5 的清单，任务是"创建 ping.txt 内容为 pong"。完整帧序列**只有 4 帧**：

```text
 1015ms  system/init
 1230ms  user          （isReplay: true）
 1231ms  assistant     （content=["text"]）
 1232ms  result/success
```

`result` 帧全文的关键部分：

```json
{"subtype":"success", "is_error":true, "terminal_reason":"api_error",
 "api_error_status":403, "stop_reason":"stop_sequence", "num_turns":1,
 "total_cost_usd":0, "modelUsage":{}, "permission_denials":[],
 "result":"Failed to authenticate. API Error: 403 {...\"Message\":\"Current user is in debt.\"}"}
```

由此得到六条结论，每条都改变实现：

1. **`subtype: 'success'` 与 `is_error: true` 会同时出现。** 若按 `subtype` 优先判定，一次认证失败会被记录成"候选完成了任务"，报告会声称候选跑完了它根本没开始的任务。**`is_error` 与 `terminal_reason` 优先于 `subtype`；`stop_reason` 完全不能用作判据。**
2. **目录校验不等于可用性。** 目录愉快地列出了 `sonnet`，真实调用 403。报告必须区分"目录已列出"与"确实跑通过"。
3. **`system/init` 会发，但在写入首条 user 消息之后。** 早前版本说"不会发 init"是错的；正确表述是**不要在提交首条消息前等待 init**（只发控制请求的那次 spike 里确实从未出现 init）。
4. **未观测到 `session_state_changed`。** 早前版本把 `state: 'idle'` 当兜底信号，此版本没有它，**不能依赖**。回合边界只有 `result`。
5. **`permission_denials` 字段确实存在**（此次为空数组），可按计划写入运行记录。
6. **账户欠费**：403 来自一个第三方网关（`apiKeySource: "none"`、目录里全是 "Custom" 模型、历史 780 次 `deepseek-v4-flash`），提示 `Current user is in debt`。**真实回合当前跑不起来**，Step F 的真机验收与 smoke-gate 在充值前无法通过。

补测（零 token，replay 回显发生在 API 调用之前）：

7. **`--replay-user-messages` 原样保留客户端自带的 `uuid`。** 发送 `{type:'user', uuid:<ours>, message:{...}}`，回显帧的 `uuid` 与之相同且带 `isReplay: true`。→ `nativeAdmission: true`、`clientMessageId: true`，回执证据是该 replay 帧。

### 6.5 `system/init` 是可观测配置的完整快照

init 帧字段（实测全量值）：

```text
cwd, session_id, uuid, model="claude-fable-5[1M]", permissionMode="bypassPermissions",
apiKeySource="none", claude_code_version="2.1.221", output_style="default",
tools(26), mcp_servers=[], plugins=[], agents(5), skills(16), slash_commands(40),
capabilities=["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
memory_paths={auto:"~/.claude/projects/<slug>/memory/"}, fast_mode_state="off"
```

这正是架构 §4.5 要的 `ExecutionRuntimeFingerprint.observableConfig`，`configHash` 可由它算出。**因此不需要 `get_binary_version` 控制请求**（`claude_code_version` 已在 init 里）。

三条由 init 暴露、早前版本完全漏掉的问题：

**(a) `--strict-mcp-config` 只隔离 MCP。** init 显示候选运行照样加载了用户的 16 个 skills、5 个 agents、40 个 slash commands 与 memory 目录。这些是历史基线可能没有的混淆变量。更强的隔离开关是 **`--safe-mode`**（禁用全部定制，但"Auth, model selection, built-in tools, and permissions work normally"）；`--bare` 太狠（强制 `ANTHROPIC_API_KEY`，会破坏 OAuth 登录）。**取舍**：`--safe-mode` 消除混淆变量但偏离历史条件，不用则保真但引入变量。两种都要在 fingerprint 里如实记录，选择本身作为实验配置暴露给用户。

**(b) 26 个内置工具里有越界能力。** 完整列表：`Task` `Bash` `CronCreate` `CronDelete` `CronList` `Edit` `EnterWorktree` `ExitWorktree` `Glob` `Grep` `NotebookEdit` `Read` `ReportFindings` `ScheduleWakeup` `SendMessage` `Skill` `TaskCreate` `TaskGet` `TaskList` `TaskOutput` `TaskStop` `TaskUpdate` `WebFetch` `WebSearch` `Workflow` `Write`。其中 `CronCreate` / `CronDelete` / `ScheduleWakeup` / `SendMessage` **在 `bypassPermissions` 下可产生工作区之外的持久副作用**（定时任务）。必须用 `--disallowed-tools` 收掉，并把收掉的清单写入 fingerprint。

**(c) 候选运行污染 `~/.claude/projects`。** spike 那次**失败**的运行也在 `~/.claude/projects/C--Users-...-reprise-claude-spike-XXXX/<session-id>.jsonl` 写了 10411 字节；`memory_paths.auto` 也指向该目录。项目目录数已从 9 涨到 15。

这会形成**反馈环**：Reprise 自己的候选运行会被 `discoverClaudeSessions()` 当作可导入的"历史会话"。两道防线都要上——`--no-session-persistence`（代价是失去候选运行自己的会话文件作为证据）与**发现阶段按 cwd 排除 Reprise 工作区与数据根**。与 `src/environment/contamination.ts` 的既有职责对齐。

### 6.6 历史模型不在当前目录里

| model | 计数 |
|---|---|
| `deepseek-v4-flash` | 780 |
| `claude-fable-5` | 189 |
| `claude-opus-4-8` | 52 |
| `<synthetic>` | 26 |

当前目录只暴露 `claude-fable-5`。历史跑过的 `deepseek-v4-flash` 与 `claude-opus-4-8` **都无法作为候选通过校验**。两条要求：

1. `SourceRuntimeEvidence.model` **原样记录**，不做白名单、不规范化、不因不认识而丢弃。
2. 报错要说清"该模型历史上跑过，但当前 CLI 目录不暴露它"，而不是笼统的"模型不存在"。

**另一处不能做等值断言**：目录报 `resolvedModel: "claude-fable-5"`，init 报 `model: "claude-fable-5[1M]"`，两个字符串不相等。以 init 的值作为本次运行的权威事实。

---

## 7. 实施顺序（契约优先，2026-08-14 确认）

```text
Step A  契约提升 + Codex 解耦 + 依赖方向测试 + 假 Pack     不新增产品，Codex 行为零变化
Step B  claude-code/sessions.ts        直接产出 ImportedSession，不含冻结
Step C  claude-code/runtime-port.ts
Step D  activity translator
Step E  pack + checkAuth + recovery playbook + 注册
Step F  smoke-gate + 真机验收 + 端到端
```

契约优先的代价与对冲：Claude 的协议风险要多悬一个重构周期。**该风险已在 2026-08-14 的 spike 中出清**（6.4/6.5）——协议形状、回合边界、入队回执、init 快照都已实测，唯一未验证的是 `bypassPermissions` 下的真实工具执行，而它被账户欠费阻塞，与实施顺序无关。

原先"从两个真实实现归纳接口比从一个归纳可靠"的理由由**假 Pack**（A.10）补上：它是一个故意与 Codex 不同形状的第二个实现，归纳接口时能立刻暴露 Codex 形状的假设，且不依赖任何真实 CLI 或凭据。

---

## 8. Step A：契约提升 + Codex 解耦

| # | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| A.1 | 落地契约：`ProductPack` / `SessionSourceAdapter` / `ImportedSession` / 产品无关 session 类型 / `TargetActivity` / `TargetActivityTranslator` / `ProductAuthStatus` | 新增 `src/products/contract.ts` | 编译通过；`overview.md` §6 与 `product-plugin-compatibility.md` 同步为代码现实 |
| A.2 | **冻结机制上提**：`freezeCase(imported, casesRoot, privacy, now)` 共享实现；Codex 的解析与冻结拆开 | 新增共享模块 + `products/codex/sessions.ts` | 既有两条 freeze 测试零 diff（幂等/脱敏/原子发布/残留清理） |
| A.3 | 产品无关 session 类型落地；Codex 三类型改别名或删除 | `contract.ts`、`products/codex/sessions.ts` | — |
| A.4 | TUI 活动词汇渲染层：`TargetActivity` → `TimelineEntry`（标签、等级、合并）全在 TUI 内 | `src/tui/timeline.ts` | 现有 Codex 帧 title/detail **逐帧不变** |
| A.5 | 清除 TUI 内 Codex 泄漏：11 个 `codex.*` 分支移入 Codex translator；`sandboxStarted` 走 `sandbox_notice`；`isPlaceholder()` 改显式标记；`itemId: 'codex-tokens'` 改 correlationId | `timeline.ts`、`products/codex/` | `rg -in codex src/tui/timeline.ts` 为空；`timeline.test.ts` 全绿 |
| A.6 | **TUI 类型去耦**：`view-projection.ts:4` 与 `pages/intake.ts:2` 不再 import Codex 类型 | 两文件 + 契约 | `rg -n "products/codex" src/tui` 为空 |
| A.7 | Codex Pack 实现新契约：`sessions` 收进 adapter、login 探测收进 `checkAuth`、保留 `recoveryPlaybook`、**删除 `CodexPack` 专属类型** | `products/codex/*` | `codex-pack.test.ts` 全绿；无行为 diff |
| A.8 | composition root 消费注册表：注册表改 `readonly ProductPack[]` + 按 id 查找；去掉 `main.ts:92` 的直接 new；`--sessions-dir` 改可重复 `<productId>=<path>`；修 `:60` 帮助文本与 `:79` 默认路径 | `cli/main.ts`、`products/index.ts` | 单产品行为不变；未知 productId 有清晰报错 |
| A.9 | `RuntimeAvailability` 补 `status` / `installHint`（`available` / `not_installed` / `unsupported_platform`） | `core/runtime.ts`、两 Pack、状态栏 | "哪个没装、怎么装"可显示 |
| A.10 | **假产品 Pack 夹具**：fake CLI + 一种三行假会话格式，完整实现契约 | 新增 `test/fixtures/fake-pack/` | 契约套件当场有第二个 Pack；不需真实 CLI/凭据即可在 CI 跑 |
| A.11 | **依赖方向架构测试**：① `src/core/**` 不 import `src/products/**`；② `src/products/**` 之外只有注册表可 import `src/products/<id>/**`；③ 任何 Pack 不 import 另一个 Pack | 新增 `test/architecture.test.ts` | ① 今天已满足要锁住；② 今天 5 处违规须清零 |
| A.12 | TUI 其余解耦（`controller.ts` 34 处是最大单点） | `controller.ts`、`workbench.ts`、`pages/intake.ts`、`view-projection.ts`、`i18n.ts` | audit frames 无回归 |
| A.13 | 实验编排解耦：放宽 `:392,442` 守卫；`:1028,1050,1071-1072` 事件解析走 Pack；`codex-tui-workflow.ts:10` 默认候选由 Pack 提供 | `src/application/*` | `codex-experiment.test.ts` 全绿 |
| A.14 | 契约一致性测试套件（参数化跑 Codex + 假 Pack）：manifest 合法、`import` 产出通过 schema、冻结幂等、脱敏、`other` 活动占比阈值 | 新增 `test/product-contract.test.ts` | 两个 Pack 全绿 |
| A.15 | 去产品名文件更名 | `codex-intake.ts` / `codex-experiment.ts` / `codex-tui-workflow.ts` | **末尾一次性做**，与逻辑改动分开 commit |

**Step A 出口条件**：`src/tui`、`src/cli`、`src/application` 内不再出现产品名（注释与默认值除外）；A.11 三条规则全绿；TUI 帧快照零 diff；全部测试绿。

---

## 9. Step B：`src/products/claude-code/sessions.ts`

**只做"私有格式 → `ImportedSession`"，不含任何冻结逻辑**（冻结由 A.2 的共享实现负责）。

### 9.1 文件发现

- 递归扫 `~/.claude/projects/*/**.jsonl`（默认根 `join(homedir(), '.claude', 'projects')`）。
- **不要从目录名反解 cwd**：`C--lhp` 这类 slug 不可逆。cwd 一律从行内 `cwd` 字段取。
- 沿用 Codex 已验证的做法：`MAX_SESSION_BYTES = 64 MiB`、mtime 排序、并发 8、单文件错误吞掉（一个坏文件不能弄坏整个 TUI 列表）。
- 文件名（去 `.jsonl`）即 `sessionId` 候选，与行内 `sessionId` 交叉校验。
- **必须排除 Reprise 自己产生的会话**（6.5c）：按 `cwd` 是否位于 Reprise 工作区/数据根下过滤，否则我们的输出会变成自己的输入。

### 9.2 行解析

**跳过**：`attachment` `last-prompt` `mode` `permission-mode` `ai-title` `custom-title` `agent-name` `file-history-snapshot` `file-history-delta` `queue-operation`，以及**任何未知 type**（默认丢弃不抛错——13 种只是今天的观测，官方明示格式随版本变化）。

**`user` 行**：content 为字符串则文本即该字符串；为数组则取 `text` block 拼接，若含 `tool_result` 则按 `role: 'tool'` 记入（文本取 `content`，`is_error` 为真时加标记）且不计入 `userMessages`；四个元信息标志为真的不作为可选初始输入。slash 命令会以 `<command-name>/model</command-name>` 形式出现在真实 user 消息里——**不做特殊解析**，靠 eligibility 与用户手选处理。

**`assistant` 行**：`text` → `assistant`；`thinking` → 按 `privacy.allowModelText` 决定是否进 transcript，`signature` 一律不留；`tool_use` → `role: 'tool'`（`name` + `input`）；`isApiErrorMessage: true`（26 条，`model` 为 `<synthetic>`）不计入 `assistantMessages` 但保留在 `historicalEvents`。

**`system` 行**：只关心 `subtype === 'compact_boundary'`。出现即说明经历过上下文压缩，**transcript 有不可恢复的缺口**，写入 `taskContext.compaction`。理由：报告若不知道基线被压缩过，会把"信息缺失"读成"模型没做"。

`signals.completedTurns` = assistant 行 `stop_reason === 'end_turn'` 的条数（本机 55 条）。**不认 `stop_sequence`**（6.2）。

### 9.3 元数据

| 目标 | 来源 |
|---|---|
| `sessionId` | 行内 `sessionId`（+ 文件名校验） |
| `startedAt` | 首行 `timestamp` |
| `cwd` | 任一消息行的 `cwd` |
| `sourceVersion` | 任一消息行的 `version` |
| `model` | **最后一条**非 `<synthetic>` 的 `assistant.message.model`，原样记录 |
| `historicalCommit` | 无对应字段；行内 `gitBranch` 写入 `taskContext`，commit 靠现场探测 |

`taskContext` 另带 `gitBranch`、`effort`、`compaction`、`permissionMode`——都是"历史上以什么配置跑的"的证据。

`ImportedSession.diagnostics` 用于记录：sessionId 与文件名不符、压缩边界、未知 type 计数、被排除的 Reprise 自产会话。**不要静默丢弃**这些事实。

`provenance.packVersion` 用 `claude-code-session-jsonl/v1`。

### 9.4 验收

fixture 覆盖全部 13 种 type + 未知 type + 纯字符串 user + tool_result user + thinking + `<synthetic>` + `compact_boundary`；真机全量 `discover` + `import` 断言全部可解析；脱敏、幂等、拒绝无 `end_turn` 的会话（后三项走 A.2 的共享冻结路径测试）。

---

## 10. Step C：`src/products/claude-code/runtime-port.ts`

### 10.1 结构对应

| Codex | Claude Code | 差异 |
|---|---|---|
| `CodexAppServerClient`（JSON-RPC） | `ClaudeStreamClient`（NDJSON + control_request/response） | 协议不同，**不共享类** |
| `CodexTargetRunner` | `ClaudeTargetRunner` | 结构可照搬 |
| `CodexRuntimePort` | `ClaudeCodeRuntimePort` | 照搬，含目录缓存 |
| `discoverCodexExecutable` | `discoverClaudeExecutable` | 照搬 PATH + PATHEXT，env 覆盖 `REPRISE_CLAUDE_EXECUTABLE` |
| `redactDiagnostic` / `forceKill` / `settlesWithin` / `positiveTimeout` | 提取共享（10.6） | — |

### 10.2 spawn 参数（全部经 `claude --help` v2.1.221 核对）

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose                              必需，缺了直接 exit 1（实测）
  --permission-mode bypassPermissions    启动时授权，运行时切换会被拒
  --model <candidate value>
  --session-id <uuid>                    必须是合法 UUID
  --replay-user-messages                 入队回执，保留我们的 uuid（实测）
  --strict-mcp-config                    只隔离 MCP，不隔离 skills/agents/memory
  --disallowed-tools <越界工具清单>       收掉 Cron*/ScheduleWakeup/SendMessage（6.5b）
  [--no-session-persistence]             见 6.5c 的取舍
  [--safe-mode]                          更强隔离，与保真度取舍（6.5a）
cwd = 隔离工作区根目录
```

**`--max-turns` 不存在**（v2.1.221 无此参数，只有 `--max-budget-usd`）。轮次预算只能由 Reprise 自己执行：`RunPolicy.maxTargetTurns` 由 Harness 计数并在超限时 `stop()`。

**绝不传 `--permission-prompt-tool`**（任何值）。它是"CLI 是否发出必须应答的 `can_use_tool` 控制请求"的总闸；不传则该路径不存在，永久挂起风险为零。代码里写成注释，不靠记忆。

**绝不传 `--fallback-model`**：它会在主模型过载时静默切换模型，对对比实验是致命的。

### 10.3 收发与回合边界

- **发**：stdin 逐行写 `{"type":"user","uuid":<我们的 id>,"message":{"role":"user","content":"..."},"parent_tool_use_id":null}`。stdin 必须挂 `error` 监听（Windows EPIPE 会崩宿主，实测踩过）。
- **收**：按行 JSON，跨 chunk 缓冲（单条 init 帧就上万字符）。
- **容忍**：`{"type":"keep_alive"}` 心跳；未知 `type` / `subtype`（开放集合）。
- **回合边界只有 `result`。** 未观测到 `session_state_changed`，**不得依赖 idle 兜底**（6.4.4）。
- **不要在写入首条 user 消息前等 `system/init`**——它在提交之后才出现（6.4.3）。但 init 一旦到达就必须捕获并存档（6.5）。

`TurnSettlement` 映射，**判定顺序即代码顺序**：

| 顺序 | 观测 | status |
|---|---|---|
| 1 | `is_error === true` 或 `terminal_reason` 非正常值 | `failed`（带 `api_error_status` / `result` 文本） |
| 2 | `subtype` 为各 `error_*` | `failed` |
| 3 | `subtype === 'success'` 且 `is_error !== true` | `completed` |
| 4 | 无法识别的 `subtype` / `terminal_reason` | **fail fast**，不等超时 |

**`stop_reason` 不参与判定**（403 时它是 `stop_sequence`，纯噪声）。第 1 条优先于第 3 条是硬要求：实测 `subtype: 'success'` 与 `is_error: true` 会同时出现，顺序错了会把认证失败记成"候选完成任务"。`confidence` 一律 `native`。

### 10.4 模型目录与 `validateCandidate`

```ts
type ClaudeModel = { value: string; resolvedModel: string; supportedEffortLevels: readonly string[] };
// 匹配 value 或 resolvedModel → 返回 { ...resolved, resolvedModel: match.resolvedModel }
```

- 目录来源：spawn 一次 + 一个 `initialize` 控制请求，零 token、~900ms、进程退出 0。
- 复用 Codex 的缓存模式（10 分钟 TTL），键含可执行文件路径与相关 env，导出 `clearClaudeCatalogCache()`。
- 报错区分两种情形（6.6）：从没听说过 vs 历史跑过但当前目录不暴露。
- **`resolvedModel` 只填 CLI 报出的值，绝不用静态列表兜底。**
- **不要断言目录的 `resolvedModel` 与 init 的 `model` 相等**（`claude-fable-5` vs `claude-fable-5[1M]`）。以 init 值为本次运行的权威事实。
- **目录通过不代表能跑**（6.4.2）。`validateCandidate` 的成功只应表述为"当前目录已列出该模型"。

### 10.5 `capabilities()`（已由 spike 定值）

| 字段 | 值 | 依据 |
|---|---|---|
| `nativeAdmission` | `true` | replay 回显是原生入队回执（实测） |
| `clientMessageId` | `true` | replay **保留客户端 uuid**（实测） |
| `nativeTurnSettlement` | `true` | `result` 是原生终态 |
| `tokenTelemetry` | `'native'` | `result.usage` / `modelUsage` 齐全 |
| `reconnectSession` | `true` | 有 `--resume` |
| `querySubmissionByClientId` | `false` | 无此查询 |
| `confirmProcessTermination` | `true` | 自己 spawn，可确认退出 |

`DeliveryReceipt`：`delivery: 'accepted'`、`evidence: 'native_event'`（replay 帧）、`messageId` 用我们发出的 uuid。

**记账坑**：`total_cost_usd` 与 `modelUsage` 在 streaming 会话里是跨轮累计值，取最后一条 `result`，不要累加。

**`stop()`**：init 报出 `capabilities: [interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1]`，存在真正的中断机制。实现顺序为"先尝试中断 → 再关 stdin → 最后杀进程"，但**以进程终止为最终手段**。

### 10.6 共享代码提取

`redactDiagnostic`（含 `SECRET_PATTERNS`）、`forceKill`、`settlesWithin`、`positiveTimeout` 目前在 `products/codex/runtime-port.ts`，与产品无关。移到 `src/products/shared/process.ts`，Codex 侧 re-export 以免动测试。**纯搬运 commit，与功能改动分开提。** 理由：`redactDiagnostic` 关系到密钥不落盘，复制两份意味着以后只补一份的风险。

协议客户端与 runner 不共享——两个产品协议不同形，现在抽象只会得到谁都不合身的基类（rule of three）。

### 10.7 验收

fake CLI 契约测试（照抄 `codex-pack.test.ts` 的 `FAKE_APP_SERVER` 模式，Claude 侧同样开一个 `args` 覆盖口）。必须覆盖：

1. 正常一轮：`init` → replay → `assistant` → `result{success, is_error:false}` → `completed`。
2. **`subtype: 'success'` + `is_error: true` → `failed`**（回归锁，防止 10.3 的顺序被改坏）。
3. `keep_alive` 与未知 `type` 混流，不影响结算。
4. 无法识别的 `subtype` / `terminal_reason` → 立即 reject，不等超时。
5. 子进程中途退出 → reject，`inspect()` 为 `stopped`，只记一条进程退出事件。
6. 进程不响应 → 请求超时并强制关闭。
7. `cancelWait` 释放被放弃的等待，晚到的结算不泄漏到下一轮。
8. 目录缓存：两个同配置实例只触发一次真实 spawn。
9. replay 回显缺失时的降级（`nativeAdmission` 不成立时的行为）。
10. `--verbose` 缺失时 CLI exit 1 的处理。

---

## 11. Step D：activity translator

| Claude 侧观测 | 目标活动 |
|---|---|
| `assistant` 的 `text` block | `message` |
| `assistant` 的 `thinking` block | `thinking` |
| `tool_use` `Bash` | `command` |
| `tool_use` `Edit` / `Write` / `NotebookEdit` | `file_change` |
| `tool_use` `Read` / `Glob` / `Grep` | `tool_call` |
| `tool_use` `WebSearch` / `WebFetch` | `web_search` |
| `tool_use` `Task` / `TaskCreate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` / `TaskUpdate` | 待定，见下 |
| `tool_use` `Cron*` / `ScheduleWakeup` / `SendMessage` / `Workflow` / `Skill` / `ReportFindings` / `EnterWorktree` / `ExitWorktree` | 待定，见下 |
| `tool_result` 的 `is_error` | 对应活动的 failed 状态 |
| `result` 的 `usage` / `modelUsage` | `token_usage` |
| `system/init` | `sandbox_notice`（记录 permissionMode / 禁用工具 / 隔离开关） |

`correlationId` 用 `tool_use.id`（`tool_result.tool_use_id` 与之配对）。

**这一步是检验 5.4 词汇设计的时刻。** 实测 Claude 有 26 个内置工具（6.5b），上表只有约 11 个落进现有类别，其余 15 个会进 `other`——**大概率超过契约套件的阈值**。届时的处置顺序是：先判断这些工具是否代表一类新的 agent 活动（`Task*` 一组像"子任务管理"，`Cron*`/`ScheduleWakeup` 像"调度副作用"），若是则回改 `TargetActivity` 加类别并让 Codex 也能用；**不要**为了压低占比把它们硬塞进不合适的现有类别。

验收：真机会话跑翻译，`other` 占比低于阈值；新增 audit frame。

---

## 12. Step E：pack + checkAuth + recovery playbook + 注册

- `manifest`：`productId: 'claude-code'`、`displayName`、`packVersion`、`schemaVersion`、`sessionSchemaVersions: ['claude-code-session-jsonl/v1']`。**不含版本矩阵**（架构 §4.3）。
- `checkAuth`：优先用 `initialize` 响应的 `account.{apiProvider, tokenSource}`（~900ms 的运行时事实）；退回文件存在性探测（`~/.claude/.credentials.json` / `ANTHROPIC_API_KEY`）。只报"已配置/未配置 + provider 名"，不读凭据内容。**注意本机 `apiKeySource: "none"` 但仍能取到目录**，所以不能把"无 API key"等同于"未配置"。
- `recoveryPlaybook`：写 `src/products/claude-code/recovery/SKILL.md`，内容来自 15 节坑表与 spike 帧序列（5.5）。
- 注册进 `src/products/index.ts`；更新 `codex-pack.test.ts` 里 `productPacks.length === 1` 的断言。

---

## 13. Step F：smoke-gate + 端到端

`smoke-gate.ts` 镜像 Codex 的人工准入清单，加四项 Claude 专属确认：

- `permissionModeConfirmed`：以 `bypassPermissions` 运行且**未**传 `--permission-prompt-tool`。
- `outOfWorkspaceToolsDisabled`：`Cron*` / `ScheduleWakeup` / `SendMessage` 已用 `--disallowed-tools` 收掉（6.5b）。
- `sessionPollutionHandled`：已选定 `--no-session-persistence` 或发现阶段 cwd 排除（6.5c）。
- `initSnapshotRecorded`：init 帧已存档为 `ExecutionRuntimeFingerprint.observableConfig` 并算出 `configHash`（6.5）。

`binaryVersionRecorded` **不再需要**独立控制请求——`claude_code_version` 已在 init 里。

**当前状态**：2026-08-14 换 DeepSeek 网关后，smoke（`ping.txt=pong`）与历史会话端到端均已通过。Host `report.html` 头栏写清 `sonnet → deepseek-v4-flash`、目录列出 ≠ 成功调用、以及 `bypassPermissions` / `--disallowed-tools` / `--no-session-persistence`。同日早先的 403 欠费记录仍保留为对照。

端到端：选一条真实历史会话 → `import` → 共享 `freezeCase` → 候选重跑 → 对比报告。检查 `report.html` 是否说清三件事：基线模型 ≠ 候选模型（6.6 必然如此）、目录校验不等于可用性（6.4.2）、候选运行的隔离开关与被禁用的工具（6.5）。

### 13.1 测试用的 Harness 模型端点

跑完整实验需要 Reprise 自己的 Harness Agent（Controller / Comparison / Recovery）有一个可用的模型端点。这与被测产品（Claude Code）无关，是 Reprise 自身的模型调用。测试期间使用的 OpenAI 兼容端点：

| 项 | 值 |
|---|---|
| `provider.kind` | `openai-compatible` |
| `baseUrl` | `https://api.dzzzz.cf` |
| `keyRef` | `OPENAI_API_KEY` |

**密钥值不写入本文档，也不写入任何被 git 跟踪的文件。** 这不是额外的谨慎，而是代码本身的要求：`src/infrastructure/harness-model-config.ts:95` 规定 `openai-compatible` 必须提供 `baseUrl` + **`keyRef`**（环境变量名），而非字面密钥；`src/tui/config-input.ts` 的 `shellEnvAssignment` 正是为生成 export 行而存在。实际值放在 `.env`（`.gitignore:12` 已忽略）或直接由 shell 环境注入：

```powershell
$env:OPENAI_API_KEY = "<key>"
```

两点待确认：该网关是否需要 `/v1` 后缀取决于其路由（`pi-model-caller.ts` 以 `api: 'openai-completions'` 传入 `baseUrl`）；`harness-model-config.ts:114-119` 的 `baseUrlValidity` 要求绝对 HTTPS 且不含凭据、query 与 fragment，当前值满足。

---

## 14. 测试策略

- **架构层**：`test/architecture.test.ts` 断言依赖方向三条规则（A.11）。这是"插件而非内置"唯一可持续的保证，grep 断言只是补充。
- **契约层**：`test/product-contract.test.ts` 参数化跑 **Codex + 假 Pack + Claude**——manifest 合法、`import` 产出通过 schema、共享冻结幂等、脱敏、`other` 活动占比阈值。
- **Pack 层**：镜像 `codex-pack.test.ts`——fixture 导入、fake 子进程协议测结算与异常路径。**必含 10.7 第 2 条**（`success` + `is_error` 的回归锁）。
- **真机层**：smoke-gate 人工清单 + 验收记录，不进 CI。
- **UI 层**：Claude 的 intake / run / result 关键帧；Step A 以现有帧零 diff 为准绳。

---

## 15. 风险与已实测的坑

| 项 | 性质 | 应对 |
|---|---|---|
| **`subtype: 'success'` 与 `is_error: true` 并存** | **已实测** | 判定顺序硬编码为 10.3 的表，配回归测试；`stop_reason` 不参与判定 |
| **目录校验通过但真实调用 403** | **已实测** | 报告区分"目录已列出"与"确实跑通过"；`validateCandidate` 成功的文案要收窄 |
| **`--max-turns` 不存在** | **已实测** | 轮次预算由 Harness 自己计数执行 |
| **候选运行污染 `~/.claude/projects` 并形成发现反馈环** | **已实测** | `--no-session-persistence` + 发现阶段按 cwd 排除，两道都上 |
| **`bypassPermissions` 下 `Cron*` / `ScheduleWakeup` 可越界产生持久副作用** | **已实测** | `--disallowed-tools` 收掉并记入 fingerprint；进 smoke-gate |
| **`--strict-mcp-config` 不隔离 skills(16)/agents(5)/memory** | **已实测** | 用 `--safe-mode` 或如实记录；隔离与保真的取舍暴露给用户 |
| **目录 `resolvedModel` ≠ init `model`** | **已实测** | 不做等值断言，以 init 为权威 |
| `--print` + stream-json 缺 `--verbose` → exit 1 | **已实测** | 参数写成常量数组 + 断言测试 |
| `system/init` 在首条 user 消息之后才发 | **已实测** | 不在提交前等 init；到达后必须存档 |
| 未观测到 `session_state_changed` | **已实测** | 回合边界只认 `result`，不做 idle 兜底 |
| Windows stdin EPIPE 崩宿主 | **已实测** | `stdin.on('error')` 必挂 |
| `session_id` ≠ `sessionId`（41 处） | **已实测** | 只读 `sessionId` |
| 工具结果混在 `type: 'user'`（532/622） | **已实测** | 按 6.2(1) 判据筛初始输入 |
| `stop_reason: 'stop_sequence'` 是 API 错误的伪装（26/26/26 三者同数） | **已实测** | `completedTurns` 只认 `end_turn` |
| 历史模型不在当前目录（`deepseek-v4-flash` 780 次） | **已实测** | 原样记录；报错可区分 |
| `compact_boundary` 造成 transcript 缺口 | **已实测** | 写入 `taskContext` 并进 diagnostics，报告需可见 |
| 所有别名都指向 `claude-fable-5` | **已实测** | 报告不应暗示对比了不同模型 |
| **账户欠费，真实回合跑不起来** | **已实测** | Step F 阻塞；Step A–E 不受影响 |
| `--fallback-model` 会静默换模型 | 文档 | 绝不传 |
| 会话 JSONL 格式官方明示无稳定性承诺 | 文档 | 未知 type 跳过；fixture 锚定 v2.1.221；`sessionSchemaVersions` 声明 |
| 控制协议未文档化，事实规范在 `sdk.d.ts` | 文档 | 只引类型不引运行时；init 的 `claude_code_version` 使漂移可追溯 |
| `bypassPermissions` 仍有例外会变终局拒绝 | 文档 | 读 `result.permission_denials` 写入运行记录 |
| 26 个工具里 15 个落不进现有活动词汇 | 已量化 | Step D 按 11 节的处置顺序决定是否扩词汇 |
| Step A 重构引入 TUI 回归 | 中 | `docs/tui-audit/` 帧快照逐帧比对；重构与行为变更分 commit |
| `controller.ts` 34 处是单文件最大解耦点 | 中 | A.12 单独 commit，先补测试再动 |
| 冻结机制上提是跨模块重构 | 中 | 以既有两条 freeze 测试零 diff 为准绳（A.2） |

### 15.1 与本计划无关的既有缺口

`src/cli/main.ts:92` 把 Codex 的 `effort: 'high'` 写死在 composition root，既不在 `CandidateSpec` 也不进 `RunManifest`，导致实验记录无法区分不同 effort 的运行。**Claude 也有 `--effort`（low/medium/high/xhigh/max）**，所以这是两个产品共有的维度，不是 Codex 专属问题。建议作为独立小修复（一个 optional 字段 + 补填 `ExecutionRuntimeFingerprint.configHash`）。A.8 会移动这行，届时**保持行为不变**，不要顺手改语义。

---

## 16. 逐步 checklist

**Step A · 契约与解耦**
- [x] A.1 `contract.ts`（Pack / adapter / ImportedSession / 无关 session 类型 / 活动词汇）
- [x] A.2 冻结机制上提为共享 `freezeCase`（两条既有测试零 diff）
- [x] A.3 产品无关 session 类型，Codex 类型改别名
- [x] A.4 TUI 活动词汇渲染层
- [x] A.5 timeline.ts 去 Codex（18 处）
- [x] A.6 TUI 类型去耦（`view-projection.ts` / `pages/intake.ts`）
- [x] A.7 Codex Pack 实现新契约 + 删 `CodexPack` 类型
- [x] A.8 composition root 消费注册表
- [x] A.9 `RuntimeAvailability` 补 status / installHint
- [x] A.10 假产品 Pack 夹具
- [x] A.11 依赖方向架构测试（5 处违规清零）
- [x] A.12 controller.ts 等 TUI 其余解耦（34 处）
- [x] A.13 实验编排解耦
- [x] A.14 契约一致性套件（Codex + 假 Pack）
- [x] A.15 去产品名文件更名（末尾一次性）

**Step B · Claude sessions.ts**
- [x] 文件发现（含排除 Reprise 自产会话）
- [x] 行解析（13 种 + 未知跳过 + 两种 content 形态）
- [x] 初始输入判据（排除 tool_result 与四标志）
- [x] 元数据 + `signals`（只认 `end_turn`）
- [x] `compact_boundary` → `taskContext` + diagnostics
- [x] 产出 `ImportedSession`（**不含冻结**）
- [x] 测试：fixture / 经共享冻结的脱敏与幂等（真机全量 discover 随 Step F 阻塞）

**Step C · Claude runtime-port.ts**
- [x] `discoverClaudeExecutable`（PATH + PATHEXT + env 覆盖，native exe 与 .cmd）
- [x] `ClaudeStreamClient`（跨 chunk 缓冲、`request_id` 配对、keep_alive/未知帧、stdin error）
- [x] 目录查询 + 缓存 + `clearClaudeCatalogCache()`
- [x] `validateCandidate`（无静态兜底、报错可区分、不做等值断言）
- [x] `ClaudeTargetRunner`（10.3 判定顺序、fail fast、cancelWait）
- [x] `capabilities()` 按 10.5 定值填
- [x] `stop()`：中断 → stdin EOF → 杀进程
- [x] 共享代码提取
- [x] 测试：10 条 fake CLI 路径（含 `success`+`is_error` 回归锁）

**Step D–F**
- [x] translator + `other` 占比达标（已扩 `subtask` / `schedule`）
- [x] pack / checkAuth / recovery SKILL.md / 注册 + 更新注册表断言
- [x] smoke-gate（含四项 Claude 专属确认）
- [x] 真机协议：嵌套 `control_response`、目录列出、init/admission、403 欠费被正确记成 failed（2026-08-14）
- [x] 真机成功回合（DeepSeek 网关：`actuallyRan=true`，`ping=pong`）
- [x] 端到端 + `report.html` 三项叙事检查（Host 头栏 `replayConditions`）
