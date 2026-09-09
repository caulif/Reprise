# Product Pack 兼容性

本文约束当前实现。未关闭验收见 [MASTER](../progress/MASTER.md)。

状态：当前架构基线

本文定义 Product Pack 的发现、选择和兼容性判定。它与[架构总览](./overview.md)、[环境设计](./environment.md)和[持久化与崩溃一致性](./persistence-and-crash-consistency.md)配套使用。

## 1. 设计目标

Product Pack 只解决两类产品私有差异：历史 session 格式，以及当前已安装 Runtime 的控制协议。个人用户需要知道的是：

- 这条历史会话属于哪个 Agent 产品，能否可靠导入；
- 当前机器上的目标 Runtime 能否启动和控制；
- 本次实际使用了哪个 executable、版本、模型解析和可观察配置；
- 同一个 Experiment 的候选执行期间，Runtime 是否意外漂移；
- 哪些闭源内部事实无法观察。

历史 Runtime 版本是 `SourceRuntimeEvidence`，只解释原始会话，不是候选运行的版本约束。Harness 不恢复、下载、缓存或切换历史 Runtime，也不把历史版本差异转换成 mismatch、warning 或探索性标签。

## 2. Product Pack 边界

```text
Product Pack
├── manifest
├── history
├── runtime
├── projection
├── recovery/SKILL.md
└── fixtures
```

- `manifest`：产品身份、Pack 版本和 session schema 声明；
- `history`：`ProductHistoryReader` 发现并导入原生会话，提取来源证据；
- `runtime`：`ProductRuntime` 发现当前安装项，启动目标 CLI、提交输入、识别 turn boundary、规范化原生事件；
- `projection`：`UserSurfaceProjection` 把标准事件译成用户可见活动；
- `recovery/SKILL.md`：Recovery Agent 使用的产品知识；
- `fixtures`：session 解析与 Runtime 适配器契约测试样例。

Product Pack 不提供 Controller 或 Comparison 的产品专属策略。它不能修改 Core 状态机、放宽隔离策略、安装 Runtime，或自行决定 fidelity。

## 3. Manifest

第一版使用简单、可读的 manifest：

```ts
interface ProductPackManifest {
  productId: string;
  displayName: string;
  packVersion: string;
  schemaVersion: number;
  apiMajor: number;
  capabilities: Array<"import" | "runtime">;
  sessionSchemaVersions?: string[];
}

interface RecoveryPlaybookDescriptor {
  version: string;
  sha256: string;
  text: string;
}
```

Manifest 不声明历史 Runtime 版本矩阵。公共 Pack API 为 `PACK_API_MAJOR` 2，端口字段见 [ProductPack 端口](../decisions/accepted/2026-09-09-product-pack-ports.md)。Runtime 适配器是否仍兼容当前产品，由固定原生事件 fixtures、最小契约测试和可选的本机 smoke 验证；失败时返回明确 diagnostic，不用一个宽泛版本范围假装兼容。

## 4. 两类 Runtime 事实

### 4.1 来源 Runtime 证据

`SourceRuntimeEvidence` 从历史 session 中尽力提取，例如产品名、当时记录的版本、模型别名和配置线索。它随 TaskCase 冻结，但只用于：

- 解释原始结果的来源条件；
- 帮助 Recovery Agent 理解历史工具或文件记录；
- 在详细报告中供用户查阅。

它不用于选择 executable、要求安装旧版本、判定环境 fidelity，或与当前 Runtime 自动做“匹配”。来源证据缺失也不阻塞候选运行。

### 4.2 当前执行 Runtime

候选运行只使用当前机器已安装的 Runtime。Product Pack 在首个候选准备时和每个候选启动前执行只读发现，并生成事实快照：

```ts
interface RuntimeAvailability {
  productId: string;
  executable?: string;
  observedVersion?: string;
  status: "available" | "not_installed" | "unsupported_platform";
  observedAt: string;
  installHint?: string;
}

interface ExecutionRuntimeFingerprint {
  productId: string;
  executable: string;
  observedVersion?: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  configHash?: string;
  observableConfig: Record<string, string | "unknown">;
  observedAt: string;
}
```

`observableConfig` 可包含工具、MCP、权限、沙箱、上下文压缩和重试设置。闭源 Runtime 不公开的内容写为 `unknown`，不猜测、不要求重建动态 system prompt。主报告默认只显示产品、实际模型和 `runtime_drift`；完整 fingerprint 保存在 manifest/trace 中。

## 5. Pack 选择流程

```text
历史会话证据
→ 读取明确的 product / session schema clues
→ 枚举已组装的 Product Pack（内置与 `{dataDir}/plugins.json`）
→ 过滤不支持的产品或 schema
→ 选择唯一匹配 Pack
→ 导入 TaskCase 和 SourceRuntimeEvidence

候选运行
→ 操作者选择已注册 Pack（可以与来源会话产品不同）
→ 对该 Pack 调用 `listCatalog`，再 `validateCandidate`
→ 写入 ExecutionRuntimeFingerprint
→ 启动 TargetRunner
```

内置 Pack 与本地配置模块走同一 registry；不实现远程发现、热加载、Pack 市场或动态依赖注入。详见[版本化本地 Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。

多个 Pack 都能解析时，按以下顺序消歧：

1. `productId` 精确匹配；
2. session schema 精确匹配；
3. fixture 覆盖范围更具体。

仍然并列时要求用户选择，并把选择写入 provenance。不得随机选择或让 Agent 默默决定解析器。历史 Runtime 版本不参与消歧。

## 6. 兼容性结果与漂移

兼容性只表达模块能否完成当前职责：

```ts
interface CompatibilityResult {
  product: "matched" | "unknown";
  session: "parsed" | "partial" | "unsupported";
  runtime: "available" | "not_installed" | "unsupported";
  environment: "isolated" | "observational" | "unsupported";
  limitations: string[];
}
```

历史 Runtime 与当前 Runtime 不同不是兼容性失败。`strict`、`exploratory`、`observational` 由架构总览中的环境、外部世界和模型解析证据派生，不由 Product Pack 决定。

同一个 Experiment 的首个候选准备时保存 Runtime 基准，每个候选启动前重新探测：

```text
预期使用同一 Runtime 且 fingerprint 稳定
→ 正常记录

预期使用同一 Runtime，但 executable、版本或关键配置变化
→ 追加 runtime_drift warning
→ 保存前后 fingerprint
→ 继续运行
```

显式选择不同 Agent 产品或不同当前配置不是漂移，但报告必须把比较解释为“实际 Agent 配置差异”；只有同一当前 Runtime 和配置下更换模型，才主要解释为模型差异。

## 7. 未知字段和 Agent 鲁棒性

以下结构事实不能交给 Agent 猜测：

- 消息顺序和 user / assistant / tool 角色；
- `initialInput`；
- 当前 executable 与 Product Pack 的绑定；
- tool call 是否发生、输入是否 accepted、turn 是否 settled；
- 工作目录、artifact ownership 和 staging 隔离；
- 已实际观察到的模型、版本和配置值。

缺失或矛盾时返回 `partial`、`unsupported` 或明确 diagnostic。不可观察的闭源配置可以是 `unknown`，不因此伪造匹配状态。

Recovery Agent 或 Comparison Agent 可以解释未知工具输出的任务意义、自然语言纠正、文件变化与任务的关系，以及结果证据如何展示。原始字段保留在 raw artifact 和 diagnostics 中；Agent 的推断不能覆盖确定性事实或标记为 `verified`。

## 8. 旧 TaskCase 与 Pack 更新

TaskCase 创建时冻结 Product Pack provenance：

```ts
interface ProductPackProvenance {
  packId: string;
  packVersion: string;
  manifestHash: string;
  adapterVersions: Record<string, string>;
  playbookHash: string;
}
```

Product Pack 更新不得改变旧 TaskCase 的含义：

- 旧 Case 的读取和报告尽量不依赖旧 Pack；
- 重新导入原始会话需要仍可用的 Session Adapter；
- 重新运行候选需要能控制当前已安装 Runtime 的 Runtime Adapter；
- 严格恢复环境需要兼容的 Recovery Playbook。

因此：

```text
旧 Case 可读取
≠
旧 Case 一定可重新运行
```

无法加载旧 Pack 时保留 Case 和已有 RunRecord，报告 `rerunnable: false`，不静默使用新 Pack 重新解释历史会话。

## 9. Runtime 缺失、适配失败与不确定操作

Runtime 发现只有三种结果：可用、未安装、平台不支持。未安装时 Product Pack 可以给出官方安装说明，但 Harness 不执行安装脚本。已安装 Runtime 若无法通过当前适配器启动、确认输入 admission 或识别 turn boundary，返回 `unsupported_runtime` diagnostic；这表示适配器与当前产品协议不兼容，不表示历史版本 mismatch。

每个 Runtime adapter 还必须声明最小恢复能力：是否能重连 session、按 `clientMessageId` 查询提交结果，以及确认目标进程已经终止。能力声明必须对应可核查的原生证据，不能仅依据 Harness 进程内状态推断。start、send 或 stop 的响应丢失时，Orchestrator 先使用这些能力核查；仍无法确认则追加相应 `uncertain.*` 事实。此时不得盲目重发输入或宣称 cleanup 成功，但可以在保存诊断和 cleanup unknown 后完成 `finalizing`。

## 10. 与其他模块的关系

```text
ProductHistoryReader
  → ImportedSession / SourceRuntimeEvidence
  → TaskCase provenance

Runtime Adapter
  → RuntimeAvailability / ExecutionRuntimeFingerprint
  → TargetEvent / TurnSettlement

Recovery Playbook + Recovery Agent
  → EnvironmentClues / recovery suggestions

Core
  → CompatibilityResult / runtime_drift
  → FidelityAssessment
```

Product Pack 可以解释产品私有事实，但不能：

- 直接修改用户当前工作目录；
- 绕过 EnvironmentPort 的隔离和权限策略；
- 安装、下载或切换 Runtime；
- 生成 Controller 输入或选择 Comparison 报告内容；
- 将不确定推断提升为确定事实。

## 11. 第一版验收条件

- 给定明确 productId 和 session schema，能唯一选择 Product Pack；
- 多个 Pack 并列时不会静默随机选择；
- 历史 Runtime 信息只进入 `SourceRuntimeEvidence`，不约束当前执行；
- 能发现当前 Runtime 并区分 `available`、`not_installed` 和 `unsupported_platform`；
- 准备成功后，每个 RunManifest 自动保存当前 Runtime 和实际模型 fingerprint；
- 同一 Experiment 的意外 Runtime 变化生成 `runtime_drift` warning，但不阻塞运行；
- system prompt 或其他闭源内部配置无法获得时记录 `unknown`，不阻塞普通运行；
- 缺失关键结构字段不会被 Agent 猜测为确定事实；
- 更新 Product Pack 后旧 TaskCase 的 provenance 和历史结果不变；
- start/send/stop 无法确认时形成 `uncertain.*` 与 cleanup unknown，不盲目重试或伪造成功；
- Harness 不自动下载、安装或切换 Runtime。

## 12. 明确不做

- 历史 Runtime 版本恢复、下载器、缓存或 Artifact Resolver；
- system prompt 版本注册表或 Runtime / schema / prompt 组合矩阵；
- 让 Agent 随机选择 Pack 或补造核心结构事实；
- Pack 市场、远程热加载和任意生命周期脚本；
- 用历史版本差异决定实验有效性。
