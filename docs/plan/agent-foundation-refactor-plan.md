# Agent 基座全面重构实施计划

状态：proposed

日期：2026-09-09

## 1. 目标

将 Controller、Comparison、Recovery 共同使用的模型执行底座重构为 Provider 无关的 `AgentHost` / `AgentSession`。三个业务 Agent 只负责各自的 prompt、工作轮次、业务 Schema 和业务工具；底座负责连续模型工作会话、工具循环、上下文压缩、结构化输出、取消、失败分类和审计。

首版以 `@earendil-works/pi-agent-core@0.84.1` 与 `@earendil-works/pi-ai@0.84.1` 为实现基础，通过薄的 `PiProviderAdapter` 复用公开 `Agent` 能力，不复制完整 Pi Agent loop。公共接口不出现 Pi 命名和 Pi 类型。

## 2. 非目标

- 不重构 Controller、Comparison、Recovery 的业务协议或轮次设计；本计划只提供它们需要的共同底座。
- 不把业务轮次、settlement、ready/blocked、send/done、report 发布或 CandidateRun 状态放入底座。
- 不支持进程崩溃后的 Session 续跑；取消后关闭，重新工作创建新 Session。
- 不设计浏览器工具；Comparison 浏览器能力由业务层后续注入。
- 不实现并行副作用工具；首版工具调用固定顺序执行。
- 不复制整个 Pi 源码，不修改 `node_modules`，不引入第二套 Session 持久化文件。
- 不新增通用 Todo、Plan、Goal 或业务 DSL。

## 3. 目标架构

```text
ControllerAgent / ComparisonAgent / RecoveryAgent
                ↓
        Reprise AgentHost / AgentSession
                ↓
          PiProviderAdapter
                ↓
             Pi Agent
                ↓
             Pi AI
                ↓
        具体模型 / Provider
```

建议目录：

```text
src/infrastructure/agent/
├─ host.ts                 # AgentHost 工厂与 Session 创建边界
├─ session.ts              # AgentSession、Invocation 与状态
├─ types.ts                # Provider 无关公共类型
├─ audit.ts                # Agent 事件与脱敏持久化适配
├─ failure.ts              # 统一失败分类
├─ compaction/             # Context Manager，优先复用 Pi 导出实现
├─ artifacts.ts             # 图片/大正文 artifact 解析与完整性校验
└─ providers/
   └─ pi/
      ├─ adapter.ts         # Pi Agent 薄包装
      ├─ message-mapper.ts  # Reprise 输入与 Pi 消息转换
      ├─ event-mapper.ts    # Pi 事件到内部事件映射
      └─ tool-adapter.ts    # Reprise 工具到 Pi 工具适配
```

依赖方向固定：

```text
agents/* → infrastructure/agent/types
infrastructure/agent → PiProviderAdapter
PiProviderAdapter → pi-agent-core / pi-ai
infrastructure/agent 不导入 application/controller、comparison、recovery
```

## 4. 公共 API 契约

### 4.1 Host 与 Session

```ts
export interface AgentHost {
  createSession(input: AgentSessionOptions): Promise<AgentSession>;
}

export interface AgentSession {
  work(input: FreeformWorkRequest): Promise<FreeformInvocation>;
  request<T>(input: StructuredWorkRequest<T>): Promise<StructuredInvocation<T>>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}
```

```ts
export type AgentSessionOptions = {
  role: string;
  model: ModelConfigSnapshot;
  systemPrompt: string;
  tools?: readonly AgentTool[];
  compaction?: CompactionPolicy;
  privacy: PrivacyPolicy;
  audit?: AgentAuditSink;
};
```

`model` 必填，创建后冻结。工具在创建时注入并固定；Session 不定义 `readOnly`、`allowNetwork` 等通用权限字段。权限由工具实现和 Environment 层强制执行。

### 4.2 两种工作请求

```ts
export type FreeformWorkRequest = {
  promptContent: string;
  promptImages?: readonly AgentImageRef[];
  signal?: AbortSignal;
};

export type StructuredWorkRequest<T> = {
  promptContent: string;
  promptImages?: readonly AgentImageRef[];
  schema: TSchema;
  outputContract: string;
  maxRepairAttempts: number;
  normalize?: (value: unknown) => unknown;
  validate?: (value: T) => string | undefined;
  signal?: AbortSignal;
};
```

`work()` 用于自主调查、工具调用、修改、验证和自然语言工作，不解析业务 JSON、不触发 repair，也不把模型原文当作业务交付。`request()` 用于业务交付，执行 JSON 提取、Schema 校验、normalize、validate 和有界 repair。repair 在同一 Invocation、同一 Session 内追加。

### 4.3 Invocation 结果

```ts
export type AgentInvocation<T> =
  | { status: "completed"; value: T; sessionId: string; invocationId: string }
  | { status: "failed"; failure: AgentFailure; sessionId?: string; invocationId?: string }
  | { status: "cancelled"; factRef?: string; sessionId?: string; invocationId?: string };

export type FreeformInvocation = AgentInvocation<{ text?: string }>;
export type StructuredInvocation<T> = AgentInvocation<T>;
```

`FreeformInvocation` 完成时的 `value.text` 是可选的可见诊断摘录，供审计与测试对照。它不是业务状态；业务 Agent 只根据 `status` 继续轮次或进入 `request()`，不得读取或依赖 `text`。

一次 Invocation 可以包含多个 Pi turn、模型请求、工具调用、retry、压缩和 Structured repair。同一 Session 同时最多一个活动 Invocation；并发直接失败，不排队。

## 5. Provider Adapter

### 5.1 复用原则

优先通过 npm 依赖复用 Pi 的公开 `Agent`、消息 block、流式事件、工具适配、顺序执行、上下文压缩和 Pi AI Provider 适配。Adapter 不复制 Agent loop。

`AgentHarness` 的 `prompt`、`compact`、`resume` 在 0.84.1 是未实现占位，不得作为执行或持久化入口。唯一运行对象是公开 `Agent`。

### 5.2 Adapter 职责

`PiProviderAdapter` 负责：

- 使用冻结的 model snapshot 创建 Pi `Agent`；
- 将 Reprise 工具转换成 Pi 工具；
- 固定 `toolExecution: "sequential"`；
- 将 `promptContent` 和已解析图片转为 Pi user message；
- 订阅 Pi 事件并映射为内部稳定事件；
- 调用 `prompt()`、`abort()`、`waitForIdle()`；
- 暴露 Pi 的模型能力、usage 和错误信息。

Adapter 不负责：

- Reprise Session/Invocation 身份；
- Freeform/Structured 业务语义；
- 业务 Schema repair；
- artifact 所有权和 Experiment 持久化；
- Controller、Comparison、Recovery 的轮次。

## 6. 消息、图片和 artifact

公共 API 不允许业务层伪造完整 assistant/tool transcript。Session 内部直接复用 Pi `AgentMessage`、content block、`toolCallId` 和事件类型。

`read` 支持图片内容。图片格式复用 Pi `ImageContent`；Reprise 维护 `artifactId`、ownership、mediaType、contentHash 和 byteLength。发送前由 Host/ArtifactResolver 校验引用和完整性，读取原文后转换成 Pi 图片 block。artifact 元数据不发送给模型。

超过内联上限的文本和图片保存为受控 artifact，事件记录引用、hash 和长度。重建模型输入时重新取 artifact、校验 hash/byteLength，再转换为 Pi block。不能只保存路径或 digest。

## 7. 上下文管理

首版直接复用 Pi compaction：

- 根据 `contextWindow - reserveTokens` 自动触发；
- 使用实际 usage，必要时估算新增消息；
- 摘要与近期完整消息并存；
- 不在 tool call/result 中间切断；
- 超长 turn 生成 prefix summary；
- previous summary 增量更新；
- 摘要失败或被截断时不提交；
- 压缩取代静默滚动截断。

Reprise 适配：

- 事件记录 `agent.context_compacted`，包含 summary、tokensBefore、retained tail 和原因；
- 压缩成功记录后才替换内存 transcript；
- 压缩使用当前 Invocation signal；
- 角色提供 `instructions`，至少要求保留目标、约束、确认事实、已完成动作、工作路径、待检查项、阻塞原因和可重读入口；
- Context Manager 不理解业务字段，不建立业务状态机。

```ts
export type CompactionPolicy = {
  reserveTokens: number;
  keepRecentTokens: number;
  instructions?: string;
};
```

## 8. 工具执行与输出限制

工具由业务/Environment 创建并强制路径与权限边界。基座顺序执行工具；普通工具错误以 `tool_result(isError: true)` 返回模型。取消、审计失败、环境失效等系统错误终止 Invocation。

复用现有 Reprise 工具限制：

- 文本工具结果和文件内容：最大 262,144 bytes；
- shell 命令输入：最大 32,768 bytes；
- 结果截断显式标记 `truncated: true`；
- 提供 offset、路径或查询入口继续读取；
- 完整原文保存 artifact，模型只接收截断版本；
- toolCallId 配对不可破坏。

## 9. 错误语义

失败分为原因 `kind` 和处理码 `code`：

```ts
type AgentFailure = {
  kind: "authentication" | "rate_limited" | "transient_network" |
    "transient_upstream" | "tool" | "timeout" | "protocol" |
    "cancelled" | "privacy" | "persistence" | "unknown";
  code: "agent_timeout" | "agent_failure" | "invalid_output" |
    "privacy_blocked" | "audit_failure" | "session_closed" |
    "concurrent_invocation";
  message: string;
  attempts: number;
  retryable: boolean;
};
```

规则：普通工具错误回模型；Provider 暂时错误有界 retry；认证错误不重试；非法 JSON/Schema 在同一 Structured Invocation 内 repair；取消独立返回 `cancelled`；审计写入失败阻止继续请求；Session 编程错误不伪装成模型失败。

取消顺序：标记取消 → abort Pi → 等待工具退出 → 丢弃晚到结果 → 写 cancelled 事件 → 关闭 Session。

## 10. 审计与事件复原

复用现有 Experiment event envelope 和 schema。Agent 事件至少包含：

```ts
type AgentEventEnvelope = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  occurredAt: string;
  runId?: string;
  sessionId: string;
  invocationId?: string;
  type: string;
  payload: Record<string, unknown>;
};
```

稳定映射：

- 完整 user/assistant/tool 消息 → `agent.message_appended`；
- tool start/end → `agent.tool_called`、`agent.tool_completed`/`failed`；
- 模型请求/原文 → `agent.model_request`、`agent.model_output`；
- retry → `agent.request_retried`；
- compaction → `agent.context_compacted`；
- invocation 终态 → `agent.invocation_completed`/`failed`/`cancelled`。

不逐 delta 持久化 `message_update` 或工具进度。所有持久化输入、模型输出和外部 JSON 经过 `Value.Check`；敏感信息脱敏；事件日志是唯一事实源。

## 11. 实施顺序

### 阶段 0：基线

- 锁定 Pi 0.84.1 依赖和许可证记录；
- 阅读并列出当前 Host 调用方；
- 建立 fake Provider Adapter；
- 保留既有测试可运行。

### 阶段 1：公共类型与生命周期

- 新增 `types.ts`、`session.ts`、`failure.ts`；
- 实现 Host/Session/Invocation 状态和并发保护；
- 覆盖 close/cancel/重复关闭/关闭后请求。

### 阶段 2：Pi Provider Adapter

- 包装公开 Pi `Agent`；
- 接入 prompt、subscribe、abort、waitForIdle；
- 固定顺序工具执行；
- 完成消息和事件映射；
- 不使用 AgentHarness。

### 阶段 3：Freeform 工作

- 实现 `work()`；
- 验证同一 Session 连续多次 work；
- 验证工具错误回模型、取消和失败语义；
- 验证图片输入和 artifact 解析。

### 阶段 4：Structured 工作

- 实现 `request()`；
- 接入 JSON 提取、normalize、Schema、validate 和 repair；
- 验证 repair 不创建新 Session/Invocation；
- 验证非法输出、未知证据和审计失败。

### 阶段 5：Context Manager

- 接入 Pi `prepareCompaction`、`compact`、`shouldCompact`、token 估算；
- 实现摘要提交顺序、事件记录和失败保护；
- 验证摘要+保留尾部、安全切点、split turn、多次压缩和图片/中文估算。

### 阶段 6：审计与复原

- 完成 Agent 事件 schema 和 artifact 引用；
- 记录实际模型输入、工具结果和压缩 retained tail；
- 从关闭后的 events.jsonl 和附件重建输入并校验 hash/长度。

### 阶段 7：业务 Agent 接入

- Controller 改为使用 Reprise AgentSession 的 work/request；
- Comparison 改为四轮 work + 最后一轮 request；
- Recovery 改为三轮 work/request；
- 删除业务 Agent 对 Pi 具体类型和模型 loop 的直接依赖；
- 保持各自业务编排和状态所有权。

### 阶段 8：清理与文档

- 删除旧 Host 命名和重复 loop；
- 更新 architecture、角色、持久化、Provider 和决策文档；
- 固定 Pi 版本/commit、许可证和升级说明；
- 更新 `MASTER` 进度。

## 12. 验收标准

### 公共行为

- 同一 Session 可顺序执行多个 work/request；
- 同一 Session 并发 Invocation 被拒绝；
- cancel 后不能追加，close 幂等；
- `work()` 不触发 JSON repair；
- `request()` 非法输出在同一 Invocation 内有界 repair。

### Pi 复用

- 使用公开 Pi `Agent`，不使用 AgentHarness；
- 工具固定顺序执行；
- 多次 prompt、subscribe、abort、waitForIdle 均有测试；
- Provider Adapter 替换不影响业务 Agent。

### 上下文与输出

- 自动 compaction 取代静默滚动截断；
- 保留安全工具配对和近期尾部；
- 压缩失败不污染工作集；
- 大输出截断可继续读取；
- 图片 artifact 可完整校验和重建。

### 审计

- Session、Invocation、消息、工具、模型请求、retry、compaction、失败和取消可复原；
- 不记录敏感凭据；
- 事件 payload 通过 Schema 校验；
- Experiment `events.jsonl` 是唯一事实源。

## 13. 测试与门禁

测试读取 `dist/`。每阶段修改源码后先运行：

```text
npm run build
```

再运行与阶段相关的测试；全部源码迁移完成后运行：

```text
npm run check
```

仅文档修改运行：

```text
npm run verify:docs
```

不得默认访问真实 Provider；真实调用必须显式 opt-in 并遵守 smoke gate。新增协议或 gate 必须附反向测试。

## 14. 风险与回滚

- Pi 公开扩展点不足：优先在 Adapter 局部适配；只有必要时复制单个 Pi 模块，并记录上游版本/commit 和 MIT 声明；
- Pi 升级改变事件或 compaction：锁版本，先跑基座回归再升级；
- 审计失败导致模型继续：审计写入必须是继续请求前的硬门禁；
- artifact 被替换：发送和复原都校验 hash/byteLength；
- 业务编排下沉到底座：架构测试禁止 infrastructure/agent 导入 application 业务模块；
- 取消后的晚到响应污染事件：按 invocation 终态拒绝追加。

## 15. 实施报告要求

每个阶段报告：修改文件、删除的旧路径、测试命令和结果、未迁移协议和剩余风险。不要以模型自述代替测试证据。完成判定必须区分代码实现、测试验证和仅文档更新。
