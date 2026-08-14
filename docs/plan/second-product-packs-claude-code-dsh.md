# 多产品 Pack 规划：Claude Code 与 DeepSeek Harness（dsh）

> 状态：已决策（2026-08-13），四个开放问题的结论见第 8 节
> 落地文档：`docs/plan/claude-code-pack-implementation.md`——**Codex + Claude Code 两产品的自足实现规划**，含共享契约设计、Codex 解耦任务表、以及两次真机 spike 得到的会话格式与控制协议事实基线。经 2026-08-14 契约评审，本文第 4 节的契约提案有三处被推翻，**以该文为准，dsh 落地时必须跟随**：
> 1. **本文 4.1 的 `SessionSourceAdapter` 含 `freeze()` 是错的。** 冻结机制（暂存目录、原子 rename、幂等、脱敏、崩溃残留清理）是产品无关的基础设施，放进 Pack 契约等于每接一个产品复制一份。已按 `architecture/overview.md:390` 改回 `discover` / `import` → `ImportedSession`，冻结由共享 `freezeCase()` 承担。Phase 2.2 的 dsh 会话适配也只产出 `ImportedSession`。
> 2. **本文 4.1 的 `ProductPack` 漏了 `recoveryPlaybook`**（`pack.ts:48` 的现存成员，`codex-experiment.ts:187` 正在调用）。已补为**必选**成员，与 `architecture/overview.md:374` 一致。
> 3. **本文 Phase 2.1 的"manifest 记录已验证的版本区间"违反 `product-plugin-compatibility.md:57`**（"不用一个宽泛版本范围假装兼容"）。版本事实属于每次运行的 `ExecutionRuntimeFingerprint`，不属于 Pack 声明。
>
> 另有若干由 dsh 单独驱动的契约设计（验证强度字段、聚合状态 pill 等）在两产品下被推迟或重新决定，逐条见该文 5.6；dsh 落地时需回读确认推迟项仍可加法引入。实施顺序与本文一致（契约优先）。
> 前置阅读：`docs/architecture/product-plugin-compatibility.md`、`docs/architecture/overview.md`（`AgentProductPlugin` 契约）、`docs/plan/reprise-post-tui-roadmap.md`
> 调研底稿：`docs/plan/second-product-packs-decision-brief.md`（含实测/源码/文档三类事实的逐条标注）
> 调研依据：本仓库 Codex 纵切片现状；本机 Claude Code v2.1.221（`~/.claude/projects/` 下已有真实会话）；本地 checkout 的 deepseek-harness `0.1.0-rc.5`（`C:\dsh\deepseek-harness`，配套说明 `C:\dsh\deepseek-harness\DEEPSEEK-HARNESS项目介绍.md`）

## 1. 目标、核心原则与不做什么

**目标**：以 Product Pack（插件）形式让 Reprise 支持两个新的目标产品，使"历史会话 → TaskCase → 候选重跑 → 对比报告"全链路对它们可用：

1. **Claude Code**（Anthropic 官方 CLI agent）
2. **DeepSeek Harness / dsh**（DeepSeek 开源 agent harness，基于 Cordis 插件运行时）

### 1.1 核心原则：TUI 与接入哪个产品无关

这是本次规划的第一性约束，优先于其他所有取舍：

1. **TUI 拥有全部展示逻辑与展示词汇。** 时间线的条目结构、来源分类、流式合并语义、标签文案、告警等级，全部由 TUI 定义。TUI 代码里不允许出现任何产品名或产品专属字面量。
2. **Pack 只做翻译，不做展示。** Pack 的职责是把自己产品的私有事件翻译成 TUI 已定义的词汇；它不决定"长什么样"，只回答"这件事属于哪一类活动"。
3. **一切产品适配都通过 Pack。** 会话发现与冻结、运行时驱动、凭据探测、事件翻译，四类适配没有例外通道；上层不得为某个产品开后门（今天的 `productId === 'codex'` 守卫、`codex.*` switch 分支都属于要清除的后门）。
4. **同一件事在三个产品里应读起来一样。** 这是原则 1 的直接后果，也是对比实验能成立的前提：Codex 的一次命令执行与 Claude 的一次 Bash 调用，在时间线上必须是同一类条目、同一套标签，否则读者会把 UI 差异误读成行为差异。

### 1.2 不做什么

- 不做插件热加载、插件市场、第三方动态发现——继续**静态注册**（`src/products/index.ts` 编译期数组）。
- 不重写 `CandidateRun` / `Comparison` / `LocalWorkspaceProvider`——它们已产品无关，只消费 `TaskCase` / `RunRecord` / `TargetRunner`。
- 不管理目标产品的内部配置。**前提是用户先把 agent 自己配好（凭据、provider、模型），Reprise 只读取与使用，不写入、不代为初始化。**
- 不为迁就某个产品而降低 TUI 的一致性（原则 1.1.4 的反面表述）。

此前 `comprehensive-project-review.md` 的结论是"在有真实第二 Runtime 之前不要做多 Pack 抽象"。现在第二、第三个真实 Runtime 已经到位，**契约提升的时机成立**，这份计划就是那次决策的兑现。

## 2. 现状盘点：契约的"文档态"与"代码态"

| 层 | 现状 | 对新 Pack 的影响 |
|---|---|---|
| `RuntimePort` / `TargetRunner`（`src/core/runtime.ts`） | 已落地、稳定，Codex 完整实现 | **直接复用**，新 Pack 各自实现一份 |
| `AgentProductPlugin` / `SessionSourceAdapter` / `ImportedSession` | 只存在于 `docs/architecture/overview.md`，无 TS 接口 | 需要**先提升为代码契约**（Phase 0） |
| 会话发现/冻结 | `src/products/codex/sessions.ts` 是 Codex 专用函数（discover/inspect/freeze） | 抽出统一接口，三个产品各自实现 |
| TUI 展示词汇 | `TimelineEntry` / `TimelineSource` / `itemId`+`patch` 合并语义**已经是产品无关的结构**（`src/tui/timeline.ts` 第 7–48 行） | **保留并明确为 TUI 资产**，是 Pack 翻译的目标词汇 |
| TUI 事件映射 | 同文件 `projectTimelineEvent` 的 `codex.*` 分支、`sandboxStarted` 的 Codex sandbox 词汇、`isPlaceholder()` 靠比对 `'Codex is writing a reply.'` 字面量驱动合并、`itemId: 'codex-tokens'` | 违反原则 1.1.1，**必须清除**；合并语义需改为显式标记而非字符串嗅探 |
| `productPacks` 注册表 | 存在但 CLI/TUI 不消费，直接 `new CodexRuntimePort()` | composition root 必须改为**从注册表选产品** |
| CLI/TUI 其余部分 | `cli/main.ts`、`tui/controller.ts`、`workbench.ts`、`codex-tui-workflow.ts` 硬编码 Codex（会话路径、login 探测、`productId !== 'codex'` 守卫） | Phase 0 的主要解耦工作量 |
| 实验编排 | `codex-experiment.ts` 的 `RunEventProjection` 解析 `codex.item_completed` 等私有事件 | 事件翻译职责下沉到 Pack |
| 环境/对比/报告 | 产品无关 | 不动 |

**一句话**：Runtime 控制面与 TUI 展示词汇都已具备产品无关的形态；卡点在**会话源适配**、**事件映射的 Codex 纵切片**与 **composition root 的硬编码**。

## 3. 两个目标产品的技术档案

事实来源与逐条标注见 `second-product-packs-decision-brief.md`；下表只保留结论。

### 3.1 Claude Code

| 维度 | 事实 |
|---|---|
| 可执行文件 | `claude`（本机 v2.1.221）；探测优先用 `get_binary_version` 控制请求（返回 `{version, buildTime}`），比解析 `claude --version` 可靠，写入实验元数据 |
| 会话存储 | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`，目录名由项目路径 slug 化（如 `C--lhp`） |
| 会话格式 | JSONL；混有元信息行（`type: mode` / `permission-mode` / `file-history-snapshot` / `attachment` 等 10 种）与消息行（`type: user` / `assistant`，`message` 为 Anthropic API 消息结构，工具调用是 `tool_use` / `tool_result` content block）；每行带 `cwd`、`gitBranch`、`timestamp`、`uuid` / `parentUuid`、`version`；`sessionId` 与 `session_id` 两种命名同时存在 |
| 编程控制面 | **直连 CLI 双向 stream-json（已决）**：`claude -p --input-format stream-json --output-format stream-json --verbose`，stdin 逐行写用户消息，stdout 逐行吐事件。不使用官方 SDK——它的 `optionalDependencies` 是 8 个平台的 CLI 二进制且与 `claudeCodeVersion` 锁步，会让被测对象由依赖树决定 |
| 协议规范载体 | CLI 官方文档未记录该协议；事实规范是 SDK 包内的 `sdk.d.ts`（7136 行带注释）。**仅作类型来源引用，运行时不依赖** |
| 回合边界 | 每轮以一条 `result` 消息收尾；`system/session_state_changed` 的 `state: 'idle'` 是更权威的结束信号。以 `result` 为主、`idle` 兜底 |
| 模型目录 | **有目录**：`initialize` 控制请求的响应含 `models`（另有 `list_models` 子类型），不发 user 消息、不触发 model turn、**零 token 消耗**。与 Codex `listModels()` 同级 |
| 无人值守 | 不传 `--permission-prompt-tool`（任何值）——它是"CLI 是否发出必须应答的 `can_use_tool` 请求"的总闸，不传则该路径不存在。权限模式见 8.3 |
| 登录/凭据 | `claude` 自身登录态（`~/.claude/.credentials.json` 或 `ANTHROPIC_API_KEY`）；Reprise 只做存在性探测，不读内容、不代为登录 |
| 已知坑 | `--print` + stream-json 输出**强制要求 `--verbose`**（否则 exit 1）；首条 user 消息前**不会**发 `system/init`；stdout 有 `{"type":"keep_alive"}` 心跳帧且消息类型是开放集合；Windows 上 stdin 需挂 `error` 监听否则 EPIPE 崩宿主；`total_cost_usd` / `modelUsage` 是跨轮累计值，取最后一条不要累加 |
| 风险 | 会话 JSONL 格式**官方明示无稳定性承诺**（"internal to Claude Code and changes between versions"）；控制协议同样未文档化 |

### 3.2 DeepSeek Harness（dsh）

| 维度 | 事实（源自 `C:\dsh\deepseek-harness` 源码与中文文档） |
|---|---|
| 可执行文件 | `dsh`（npm 包 `@deepseek-ai/dsh`，`0.1.0-rc.5`，developer preview）；探测 `dsh --version` |
| **驱动前置条件** | JSON-RPC runtime 的 bin 是 `dsh-jsonrpc-agent`，来自 **`@deepseek-ai/dsh-sdk-jsonrpc-demo`**，**不随 `@deepseek-ai/dsh` 安装**；且该 runtime 无内置默认配置，**必须**由调用方经 argv 或 `DSH_CORDIS_CONFIG` 传入 `cordis.yml`。Python 打包 exe 只覆盖 linux/macos，**Windows 只能走 Node + demo 包** |
| 会话存储 | `%USERPROFILE%\.dsh\sessions\--<normalized-cwd>--\<encoded-session-id>\session.jsonl.zstd`（默认 zstd，可配 `compression: none`）；另有 SQLite 后端（不作为读取目标） |
| 会话格式 | 首行 `SessionHeader`（`type: 'session'`，含 `id`、`cwd`、`createdAt`）；后续行为 `SessionEvent` 信封 `{ type, seq, time, data }`；关键事件 `user/message`、`assistant/message`（含 `usage`）、`tool/call`、`tool/result`、`turn/start`、`turn/end`（`reason.kind`）、`request/context`（`provider`/`model`） |
| 编程控制面 | **直连 stdio JSON-RPC（已决）**：spawn `dsh-jsonrpc-agent`，client→server 仅 3 个方法（`initialize` / `session/prompt` / `shutdown`），server→client 仅 4 类通知（`session.event` / `session.status` / `subagent.started` / `subagent.finished`），**server→client 请求数量为零** |
| 回合边界 | 组合语义：先等 `session.event` 中 `agent/inbox/spliced` 出现自己的 messageId 确认入队，再等 `session.status === 'idle'`。**这是自实现的主要风险点**，官方 SDK client 的 `run()` 封装的正是它 |
| 审批 | 不在 wire 上；走运行时内部 Cordis `approval/request` waterfall，**无监听器时返回 `unavailable` 并 fail-closed（拒绝），不会挂起等外部应答** |
| 无人值守 | `initialize` 无 auto-approve 开关；由 **cordis.yml 组合**决定（官方 `examples/jsonrpc-agent/cordis.yml` 不加载 approval UI 与 `ask_user`；`minimal.cordis.yml` 用 `sandbox-policy: danger-full-access`）。**该配置由用户提供，Reprise 不代为编写** |
| 模型与凭据 | 凭据 `$DSH_HOME/.credentials.yaml`，settings `$DSH_HOME/settings.yaml`（含 `agent-default-model` 用户选择）。`initialize` 的 `provider` / `model` 为必填，**取值来自用户已配好的 settings**，Reprise 不写入配置 |
| 模型目录 | **无**：`initialize` 只返回 `serverInfo`，provider/model 声明即接受；无 `dsh models` 命令 |
| cwd 还原 | `SessionHeader.cwd` 记录绝对路径，历史会话可直接还原任务目录（对应 `taskCase.taskContext.historicalCwd`） |
| 风险 | rc 版本明确允许破坏性变更（**锁定版本**）；**无协议版本协商**（`serverInfo.version` 硬编码 `0.0.1` 且客户端不校验）；**wire 上没有 cancel**——客户端超时只是自己放弃等待，服务端那一轮仍在继续，真正终止只能靠 stop/kill 进程；读会话需 zstd 解压依赖 |

### 3.3 与 Codex Pack 的同构性检查

三个产品在**同一形状**上成立，这是"直连子进程 + 行式 JSON"作为统一实现路线的依据：

```text
本地历史会话文件(JSONL 变体, 含 cwd)        → SessionSourceAdapter
子进程 + 行式 JSON 协议的编程控制面          → RuntimePort / TargetRunner
  Codex:       app-server JSON-RPC
  Claude Code: CLI 双向 stream-json
  dsh:         dsh-jsonrpc-agent stdio JSON-RPC
产品私有事件 → TUI 拥有的活动词汇            → Pack 内 translator
```

差异点（契约设计要吸收的）：

- **模型验证强度**：Codex 与 Claude Code 都能做真实目录校验（运行时报出模型名）；dsh 只能"声明即接受"。→ 契约需要显式的验证强度字段，而不是让某个 Pack 用静态目录冒充运行时证据（见 8.2）。
- **无人值守的开关位置**：Codex 在 sandbox 参数；Claude 在启动参数（`--permission-mode` + 不传 `--permission-prompt-tool`）；dsh 在用户的 cordis.yml。→ 契约不统一这件事，只要求每个 Pack 在 preflight 阶段能报告"当前是否为无人值守配置"。
- **终止能力**：Codex/Claude 可靠杀进程即停；dsh 无 wire cancel。→ `TargetRunner.stop` 的实现必须以进程终止为最终手段，`cancelWait` 不能假设服务端会停。
- **会话读取成本**：dsh 需要 zstd 解压。→ `SessionSourceAdapter` 不假设"纯文本可流式读"。
- **登录探测位置**：三处各异。→ 提升为 Pack 的 `checkAuth()`。

## 4. 契约设计（Phase 0 的产出物）

放在 `src/products/contract.ts`（契约属于产品接入层，不进领域核心）。

### 4.1 Pack 契约

```ts
export interface ProductPack {
  readonly manifest: ProductPackManifest;   // productId, displayName, packVersion, schemaVersion,
                                            // sessionSchemaVersions, verifiedRuntimeVersions
  readonly runtime: RuntimePort;            // 既有接口
  readonly sessions: SessionSourceAdapter;  // 新增：会话发现/检查/冻结
  readonly activity: TargetActivityTranslator; // 新增：私有事件 → TUI 活动词汇
  checkAuth(): Promise<ProductAuthStatus>;  // 新增：凭据存在性探测（只读、不落密钥）
}

export interface SessionSourceAdapter {
  discover(options: DiscoverOptions): Promise<readonly SessionSummary[]>;
  inspect(ref: SessionRef): Promise<SessionInspection>;
  freeze(ref: SessionRef, destination: string): Promise<TaskCase>;
}
```

### 4.2 展示的分工：TUI 拥有词汇，Pack 只做翻译

`src/tui/timeline.ts` 已有的 `TimelineEntry` / `TimelineSource` / `itemId`+`patch` 合并语义**就是 TUI 的展示资产**，保留不动。要新增的是一层 TUI 定义的**活动词汇**，作为 Pack 翻译的目标：

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

/** 活动 + 合并标识。合并语义由 TUI 实现，Pack 只提供稳定标识。 */
export type TargetActivityEntry = {
  activity: TargetActivity;
  /** 同一逻辑条目的稳定 id（流式增量合并用），Pack 负责其在本产品内唯一。 */
  correlationId?: string;
  merge?: 'replace' | 'append';
};
```

四条约束：

1. **Pack 不产出 title / detail / level。** 标签文案与告警等级由 TUI 从 `kind` 与字段推导。这是"同一件事在三个产品里读起来一样"的机制保证——Pack 无法通过自己写文案来产生差异。
2. **`kind` 是封闭集合。** 新增类别要改 TUI，属于有意的摩擦：它强迫我们判断"这是一类新的 agent 活动，还是某产品的实现细节"。`other` 是逃生口而非常态，契约测试应断言真实会话翻译后 `other` 的占比低于阈值。
3. **翻译只覆盖本 Pack 命名空间**（`codex.*` / `claude.*` / `dsh.*`）。`run.*` / `controller.*` / `comparison.*` / `input.*` / `runtime.*` / `artifact.*` / `environment.*` / `report.*` 是产品无关的领域事件，继续由 TUI 自己投影。
4. **未知事件降级为丢弃**（沿用现有 `default: return []` 行为），不得抛错——三个产品的事件集合都会随版本增长。

顺带修掉一处现存缺陷：`isPlaceholder()` 目前靠比对 `'Codex is writing a reply.'` / `'Codex is reasoning.'` 两个字面量来决定流式合并是否保留旧内容。这既是产品泄漏，也是脆弱设计（改一个字就失效）。改为在 TUI 内部用显式标记（如活动的 `streaming?: true` 派生出的 placeholder 标志）驱动合并。

### 4.3 其他设计约束

1. **签名从 Codex 现状反推**，不凭空设计：`discover/inspect/freeze` 以 `src/products/codex/sessions.ts` 现有函数为准做最小泛化，Codex Pack 改为实现该接口（纯搬运，不改行为）。
2. `TaskCase` / `RunRecord` 的领域 schema 不动；模型验证强度字段是唯一预期改动（见 8.2）。
3. `smoke-gate` 保持 per-pack 可选文件，接口不进契约（人工准入清单本就是产品私有的）。
4. **Pack 目录是依赖边界**：产品专属依赖（如 dsh 的 zstd 解压）只能在该 Pack 目录内 import，不得出现在 `src/core` / `src/tui` / `src/application`。

## 5. 实施阶段

### Phase 0：契约提升 + Codex 解耦（不新增任何产品，行为零变化）

风险最低但最关键：把 Codex 纵切片改造成"第一个规范 Pack"。

| # | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| 0.1 | 落地 `ProductPack` / `SessionSourceAdapter` / `TargetActivity` / `TargetActivityTranslator` 契约 | 新增 `src/products/contract.ts` | 类型编译通过；同步更新 `overview.md` 使文档与代码一致 |
| 0.2 | TUI 侧建立活动词汇渲染层：`TargetActivity` → `TimelineEntry`（标签、等级、合并）全部在 TUI 内实现 | `src/tui/timeline.ts` | 现有 Codex 帧的 title/detail 逐帧不变 |
| 0.3 | 清除 TUI 内的 Codex 泄漏：`codex.*` switch 分支移入 Codex Pack 的 translator；`sandboxStarted` 改走 `sandbox_notice`；`isPlaceholder()` 改为显式标记；`itemId: 'codex-tokens'` 改为 Pack 提供的 correlationId | `src/tui/timeline.ts`、`src/products/codex/` | `grep -in "codex" src/tui/timeline.ts` 为空；`timeline.test.ts` 全绿 |
| 0.4 | Codex Pack 实现新契约：`sessions.ts` 收进 `SessionSourceAdapter`，login 探测收进 `checkAuth` | `src/products/codex/*` | `codex-pack.test.ts` 全绿；无行为 diff |
| 0.5 | composition root 改为消费注册表：从 `productPacks` 取 Pack，去掉直接 `new CodexRuntimePort()`；`--sessions-dir` 改为可重复的 `<productId>=<path>`（详见 8.4） | `src/cli/main.ts`、`src/products/index.ts` | 单产品时 CLI 行为不变；未知 productId 有清晰报错 |
| 0.6 | TUI 其余解耦：`controller.ts` 走 `pack.sessions.*` 与 `pack.checkAuth()`；`workbench.ts` 状态栏改聚合 pill | `src/tui/controller.ts`、`workbench.ts`、`pages/intake.ts`、`view-projection.ts` | TUI audit frames 无回归（`docs/tui-audit/` 重录比对） |
| 0.7 | 实验编排解耦：放宽 `productId === 'codex'` 守卫；`RunEventProjection` 改走 Pack；`DEFAULT_CANDIDATE` 由所选 Pack 提供 | `src/application/codex-experiment.ts`、`codex-tui-workflow.ts` | `codex-experiment.test.ts` 全绿；去 codex 前缀的文件更名放在本阶段末尾一次性做 |
| 0.8 | 契约一致性测试套件（任意 Pack 跑同一组断言：manifest 合法、freeze 幂等、脱敏、`TaskCase` schema 校验、`other` 活动占比阈值） | 新增 `test/product-contract.test.ts` | Codex Pack 通过全部断言 |

**Phase 0 出口条件**：`src/tui`、`src/cli`、`src/application` 内不再出现产品名（注释与默认值除外）；全部测试绿；TUI 帧快照零 diff。

### Phase 1：Claude Code Pack（第二个产品，验证契约）

先做 Claude Code：本机已有真实历史会话可当基线素材；CLI 稳定度高于 dsh 的 rc 版；无额外安装前置条件。

| # | 任务 | 要点 | 验收 |
|---|---|---|---|
| 1.1 | `src/products/claude-code/sessions.ts` | 扫 `~/.claude/projects/**/*.jsonl`；**未知 `type` 一律跳过**（已知元信息行有 10 种，且会增长）；从首条 `type: user` 提取 `initialInput`，行内 `cwd` 提取 `historicalCwd`，末条 assistant 文本作 `baseline.finalMessage`；容忍 `sessionId` / `session_id` 两种命名；脱敏规则对齐 Codex | 本机真实会话 + 构造 fixture 双路测试；产出通过 `TaskCaseSchema` |
| 1.2 | `src/products/claude-code/runtime-port.ts` | spawn `claude -p --input-format stream-json --output-format stream-json --verbose`（cwd = 隔离工作区）；**不传 `--permission-prompt-tool`**；权限参数见 8.3；`start/send` 写 stdin，`waitForTurn` 以 `result` 为主、`session_state_changed: idle` 兜底；容忍 `keep_alive` 与未知 type；stdin 挂 `error` 监听；`stop` 杀进程 | fake-CLI 契约测试（照抄 `codex-pack.test.ts` 的 fake app-server 模式）；真机 smoke 一次 |
| 1.3 | 真实模型校验 | `validateCandidate` 用 `initialize` 控制请求取 `models` 做目录匹配，返回运行时报出的真实模型名，验证强度 `catalog`；**不使用静态目录**。同时用 `get_binary_version` 记录真实 CLI 版本 | 未知模型在启动前报错；零 token 消耗可验证 |
| 1.4 | `checkAuth` | 探测 `~/.claude/.credentials.json` 或 `ANTHROPIC_API_KEY`；只报"已配置/未配置" | 状态栏聚合 pill 正确 |
| 1.5 | `activity` translator | stream-json 的 assistant 文本 → `message`、`tool_use` → `command` / `file_change` / `web_search` / `tool_call`、thinking → `thinking`、`result` 统计 → `token_usage` | 真实会话翻译后 `other` 占比低于阈值；新增 audit frame |
| 1.6 | 事件归一化 | stream-json 行 → `TargetEvent`（`claude.*` 命名空间，具体命名实施时定） | 归一化单测 |
| 1.7 | `smoke-gate.ts` + 人工验收 | 清单：真机登录、真实小任务一轮、冻结一条真实历史会话 | 验收记录入库 |
| 1.8 | 注册 + 端到端 | `productPacks = [codex, claudeCode]`；跑一次完整实验（历史会话 → 冻结 → 候选重跑 → 对比报告） | `report.html` 生成且叙事正确；契约套件对新 Pack 全绿 |

**Phase 1 出口条件**：用一条真实 Claude Code 历史会话完成端到端实验；Phase 0 的契约无需为 Claude 破例（若必须改，记 ADR 说明契约缺口）。

### Phase 2：dsh Pack（第三个产品）

| # | 任务 | 要点 | 验收 |
|---|---|---|---|
| 2.1 | **前置条件探测与告知** | 检测 `dsh --version`、`dsh-jsonrpc-agent` 是否可用、用户是否提供了 cordis.yml 路径（配置项，Reprise 不代写）；任一缺失时给出可操作的指引而非模糊报错；manifest 记录已验证的 dsh 版本区间，版本不符时明确警告 | 三种缺失情形各有清晰文案的单测 |
| 2.2 | `src/products/dsh/sessions.ts` | 扫 `%USERPROFILE%\.dsh\sessions\**\session.jsonl(.zstd)`；zstd 解压用纯 JS 实现（倾向 `fzstd`，免 native 构建，只在本 Pack 内 import）；解析 `SessionHeader` + `user/message` / `assistant/message` / `turn/end` 事件链 | 压缩与非压缩两种 fixture + 真机会话测试 |
| 2.3 | `src/products/dsh/runtime-port.ts` | 直连 stdio JSON-RPC：spawn `dsh-jsonrpc-agent`（配置经 argv / `DSH_CORDIS_CONFIG`）；`initialize`（cwd=隔离工作区，provider/model 取自用户 settings，见 8.3）→ `session/prompt` → **等 `agent/inbox/spliced` 确认入队，再等 `session.status === 'idle'`** → 映射 `TurnSettlement`；**`stop` 以进程终止为最终手段**（wire 无 cancel）；实现 shutdown → stdin EOF → SIGTERM → SIGKILL 阶梯 | fake JSON-RPC agent 契约测试（含"服务端不响应 shutdown"路径）+ 真机 smoke |
| 2.4 | 模型解析与凭据 | 从 `$DSH_HOME/settings.yaml` 读取用户已配好的 provider/model，用 `CandidateSpec.requestedModel` 在其中定位；定位不到或有歧义时 fail-fast 提示"先在 dsh 里配置该模型"；验证强度 `declared`；`checkAuth` 探测 `.credentials.yaml` 存在性（不读值） | 未配置时启动前报错，文案指向 dsh 而非 Reprise |
| 2.5 | `activity` translator | `tool/call` → `command` / `tool_call`、`assistant/message` → `message`、`turn`/`step` 边界与 `request/context` 的模型信息 → 相应活动 | `other` 占比达标；新增 audit frame |
| 2.6 | `smoke-gate.ts` + 人工验收 | 清单：版本探测、真机一轮任务、冻结一条真实会话 | 验收记录入库 |
| 2.7 | 注册 + 端到端 | `productPacks = [codex, claudeCode, dsh]`；完整实验一次 | 报告正确；契约套件全绿 |

**Phase 2 出口条件**：同 Phase 1；额外把"dsh 版本升级回归清单"写入该 Pack 的 README（rc 期维护成本要显性化）。

### Phase 3：收尾与文档

- 更新 `docs/architecture/overview.md` / `product-plugin-compatibility.md`：契约从"文档提案"改为"代码现实"，链接 `contract.ts`；写明 TUI/Pack 的展示分工。
- 更新 `docs/product/tui.md`：产品在 intake 中的呈现方式、候选产品选择、聚合状态 pill。
- `docs/progress/MASTER.md` 记录里程碑；归档本计划与决策简报。
- 若 recovery playbook 在 dsh/Claude 场景确有需要（子进程残留、会话目录污染），此时挂接；否则记录"暂不需要"。

## 6. 里程碑与排序

```text
M0  Phase 0 完成：单产品行为不变，契约与展示分工落到代码里   （最大重构风险集中在此，先做）
M1  Phase 1 完成：Claude Code 端到端实验跑通                （契约被第二产品验证）
M2  Phase 2 完成：dsh 端到端实验跑通                        （契约被第三产品复验；rc 风险隔离在 Pack 内）
M3  Phase 3 完成：文档对齐，计划归档
```

严格串行：M0 未绿不开 M1；M1 中若发现契约缺口，先回改契约再继续（每次回改记 ADR）。Phase 1 与 Phase 2 的 Pack 内部任务（sessions / runtime / translator）可并行开发，但**注册与端到端验收必须串行**，保证任何时刻主干可发布。

## 7. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| dsh 需额外安装 `@deepseek-ai/dsh-sdk-jsonrpc-demo` 且必须由用户提供 cordis.yml | 高 | Phase 2.1 把前置条件做成显式探测 + 可操作指引；不隐式代写配置；若前置条件长期无法满足，按 8.1 的退出条件重估是否推迟 dsh |
| dsh 处于 developer preview，协议/存储格式可能破坏性变更，且无版本协商 | 高 | manifest 锁版本区间；协议代码集中在单文件；升级回归清单文档化；依赖不外泄出 Pack 目录 |
| dsh 无 wire cancel，超时后服务端仍在跑 | 中 | `stop` 以进程终止为最终手段；`cancelWait` 不假设服务端会停；清理状态如实写入 `RunOutcome.cleanup` |
| dsh 回合边界是组合语义，自实现易错 | 中 | fake agent 契约测试覆盖入队确认与 idle 两步；若真机反复出现边界误判，按 8.1 触发条件切官方 SDK client 并记 ADR |
| Claude Code 会话 JSONL 官方明示无稳定性承诺 | 中 | 解析器对未知行类型宽容跳过；fixture 锚定 v2.1.221；`sessionSchemaVersions` 声明已验证版本；不依赖它做运行时观测（自己 spawn 的进程有完整 stdout 流） |
| Claude 控制协议未文档化，事实规范在 `sdk.d.ts` | 中 | 只引类型不引运行时；启动时用 `get_binary_version` 记录真实 CLI 版本进实验元数据，让协议漂移可追溯 |
| Phase 0 重构引入 TUI 回归 | 中 | 依赖既有 `docs/tui-audit/` 帧快照逐帧比对；重构与行为变更严格分 commit |
| 三产品的权限/沙箱配置不对等，成为对比结论的混淆变量 | 中 | 每个 Pack 在 preflight 报告"是否无人值守配置"，并写入 manifest；报告如实呈现，不声称能力面等价（见 8.3） |
| dsh 的 `declared` 验证强度弱于其他两个产品 | 中 | 契约用显式验证强度字段（8.2），报告标注级别，不用静态目录伪造运行时证据 |
| 三产品并存后 TUI 信息密度上升 | 低 | 不新增产品选择页；状态栏用聚合 pill；产品维度复用现有筛选位（8.4） |
| Windows 路径/编码差异（三产品会话目录都在用户目录下，含 CJK 项目名） | 中 | 沿用 Codex sessions 的路径处理与 CJK 用例（`11-sessions-cjk-selected` 等帧已有先例），三个 adapter 共享测试夹具模式 |

## 8. 已决事项（2026-08-13）

### 8.1 控制面实现：三个 Pack 一律"子进程 + 行式 JSON 协议直连"

不使用任何官方 SDK。理由：依赖面最小，三个 Pack 在实现手法上保持一致，且被测运行时的版本完全由我们掌控（Claude SDK 会自带并锁步一份 CLI 二进制，这对对比实验是架构性问题）。

代价已知并接受：dsh 侧需自行实现回合边界的组合语义与进程回收阶梯（官方 SDK client 封装的正是这两块）。

**切换到官方 SDK 的触发条件**（任一成立即评估并记 ADR，不靠感觉决定）：

- 回合边界在真机上出现无法通过测试稳定复现/修复的误判（漏判轮次结束或提前判定）；
- 出现必须由客户端应答的服务端请求（dsh 目前 wire 上为零，但 Python SDK 已预留 approval 应答接口，属于未来可能启用的功能）；
- 协议在一次版本升级中变动到自维护成本超过依赖成本。

### 8.2 Claude Code 做真实校验，并为验证强度引入显式字段

Claude Code 的 `validateCandidate` 走 `initialize` / `list_models` 控制请求做**真实目录校验**，返回运行时报出的模型名——不使用静态目录冒充。该路径不发 user 消息，零 token 消耗，与 Codex 同级。

同时在 `ResolvedRuntime` / `RunManifest` 上加显式的验证强度（`catalog` / `probe` / `declared`），并放宽 `resolveVerifiedCandidate` 的守卫：Codex 与 Claude 报 `catalog`，dsh 报 `declared` 且 `resolvedModel` 保持 `unknown`（schema 已允许该值）。这样三个产品都说真话，报告可以如实呈现校验级别。

> 待确认（一句话即可）：Claude 侧是否还需要在 `catalog` 之外再加一次**消耗 token 的真实 probe**（发一条极短消息验证模型确实可用）？本计划按"不加"实施——目录校验已由运行时报出真实模型名，而 probe 会产生费用与副作用；如需 liveness 保证，可作为 preflight 的可选开关。

### 8.3 不管理目标产品的内部配置

前提是用户先把 agent 配好，Reprise 只读取与使用。具体落地：

- **dsh**：`initialize` 的 `provider` / `model` 为必填，取值来自用户已配好的 `$DSH_HOME/settings.yaml`，用 `CandidateSpec.requestedModel` 在其中定位；定位不到或歧义时 fail-fast，文案指向"请先在 dsh 中配置该模型"。cordis.yml 由用户提供路径，Reprise 不代写。**因此 `CandidateSpec` 不需要为 dsh 增加 provider 字段，`src/core/schema.ts` 的领域 schema 保持不动。**
- **Claude Code**：凭据与登录态由 `claude` 自己管理，Reprise 只做存在性探测。
- **权限模式**：Phase 1 按 `--permission-mode bypassPermissions`（启动时授权，运行时切换会被拒）实施，以使能力面尽量接近 Codex；不传 `--permission-prompt-tool`，因此不存在挂起路径。已知它不是"绝不询问"的保证（6 类例外会变成终局拒绝并记入 `result.permission_denials`）。三产品权限配置不对等这件事按风险清单处理：preflight 报告配置、报告如实标注，不声称能力面等价。

> 遗留项（与本次三个产品无关，可独立处理）：`src/cli/main.ts` 第 92 行把 Codex 的 `effort: 'high'` 写死在 composition root，它既不在 `CandidateSpec` 也不进 `RunManifest`，导致实验记录无法区分不同 effort 的运行，也无法在一个实验里对比 high vs low。这是既有的可复现性缺口，建议作为独立小修复（一个 optional 字段 + 补填 `RunManifest.runtime.configHash`），不阻塞本计划。

### 8.4 CLI 参数与 TUI 交互形态（本项由执行方决定）

**不引入 `--product` 参数。** CLI 保持启动器角色（现共 4 个参数），产品选择属于工作台状态，不属于 argv——把产品矩阵搬进参数表会与 TUI 内的选择重复且容易不一致。

- **`--sessions-dir` 改为可重复的 `--sessions-dir <productId>=<path>`**，未指定的产品用 Pack 默认路径。理由：该参数当前的帮助文本是 Codex 专属（"Read Codex rollout JSONL files"），三产品各有默认根目录后单值已无意义；改成带产品限定的重复参数既消除歧义，又保留测试与 fixture 需要的逃生口。
- **TUI 不新增产品选择页。** 三个 Pack 的会话**汇总进现有 projects / sessions 列表**并增加产品列，产品筛选复用已有的 `[f] Filter`（标题栏已有 `filter: all` 的位置）。理由：多数时候只有一个产品有历史会话，插入前置选择页会让常见路径变长；而汇总列表恰好回答"我在哪些工具上做过这个项目"。
- **候选产品在 run / preflight 页选择**，默认与来源产品相同——该页已在显示候选与解析后的运行时，是候选配置的自然归属。
- **状态栏改聚合 pill**（如 `● agents 2/3`）替代 per-product login pill，明细进 `/config`。理由：home 页 120 列已排 4 个 pill，compact 帧更紧，三个 login pill 会挤爆窄终端。
- **跨产品重放**（如 Codex 历史会话交给 Claude Code 重跑）：契约层保持 `TaskCase.source.productId` 与 `CandidateSpec.productId` 两个维度**解耦**（今天代码本就没有耦合它们），但 **UI 先只暴露同产品重放**，跨产品作为后续显式开关。理由：解耦不花成本且保留了这个能力，而现在就开放它需要同步设计报告叙事如何表达"跨产品"这一事实，属于独立课题，不该压在本次三个 Pack 的落地上。

以上五项在 Phase 0.5 / 0.6 出 TUI 帧提案时以帧为准做最终校对；若帧上发现问题，改动记录在本节。

## 9. 测试策略汇总

- **契约层**：`test/product-contract.test.ts` 参数化跑三个 Pack——manifest 合法、freeze 幂等、脱敏、`TaskCase` schema 校验、翻译结果中 `other` 活动占比低于阈值。
- **Pack 层**：每个 Pack 镜像 `codex-pack.test.ts` 模式——fixture 导入、tmp 目录冻结、fake 子进程协议（fake stream-json CLI / fake JSON-RPC agent）测 `TargetRunner` 结算与异常路径（协议错误、子进程崩溃、不响应 shutdown）。
- **真机层**：每个 Pack 一份 smoke-gate 人工清单 + 验收记录（登录/前置条件、真实一轮任务、真实会话冻结），不进 CI。
- **UI 层**：TUI audit frames 为每个产品补 intake / run / result 关键帧；Phase 0 重构以现有帧零 diff 为准绳；`grep` 断言 `src/tui` 内无产品名。
