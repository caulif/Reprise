# Agent 基座重构讨论记录

状态：proposed

日期：2026-09-09

## 1. 背景与目标

Controller、Comparison 和 Recovery 计划整体重构。三者需要共享一个不承担业务编排的 Agent 基座，负责连续模型会话、工具循环、上下文管理、结构化输出、取消、错误处理和审计。

基座应当与具体模型 Provider 解耦。公共接口不使用 Pi 命名；Pi 仅作为首版实现参考和可复用代码来源。

## 2. 已确定的架构边界

调用关系为：

```text
ControllerAgent / ComparisonAgent / RecoveryAgent
                ↓
             AgentHost
                ↓
           AgentSession
                ↓
        Provider Adapter
                ↓
       具体模型 / Provider
```

### AgentHost

AgentHost 是 Session 工厂和通用边界，负责：

- 创建 Session；
- 注入 Provider Adapter；
- 校验创建参数；
- 提供一次性调用能力；
- 传递模型能力和运行策略。

### AgentSession

AgentSession 是连续模型工作会话，负责：

- 维护内存 transcript；
- 顺序接受多个 Invocation；
- 执行模型与工具循环；
- 支持 Freeform 和 Structured 两种工作请求；
- 管理上下文容量和压缩；
- 处理取消、关闭和错误；
- 产生可审计事件。

同一 Session 同时最多一个活动 Invocation。Invocation 结束不自动关闭连续 Session；取消会关闭 Session。首版不支持进程退出后的 Session 续跑，任务中断后重新创建 Session。

业务轮次顺序由三个 Agent 或 application 层负责，基座不理解 Controller 的 settlement、Comparison 的四轮或 Recovery 的三轮。

## 3. 两种通用工作请求

```ts
type FreeformRequest = {
  promptContent: string;
  signal?: AbortSignal;
};

type StructuredRequest<T> = {
  promptContent: string;
  schema: TSchema;
  outputContract: string;
  maxRepairAttempts: number;
  normalize?: (value: unknown) => unknown;
  validate?: (value: T) => string | undefined;
  signal?: AbortSignal;
};
```

两种请求共享工具、上下文压缩、取消、审计和错误传播。Freeform 返回自然文本或可见结果，不解析业务 JSON、不触发 Schema repair；Structured 才解码、校验和执行有界 repair。

## 4. 工具边界

工具在创建 Session 时注入，并在 Session 生命周期内保持固定。基座只负责工具调度、顺序执行、参数边界、取消、结果回传和审计；工具的路径范围、读写权限和角色差异由环境或业务层创建的工具实现强制执行。

Pi 的通用工具集合可作为参考：`read`、`bash/powershell`、`edit`、`write`、`grep`、`find`、`ls`。当前不新增 Todo、Plan、Goal、业务选择器或恢复 DSL。七个工作区工具是共享工具库，不是每个 Agent 必须使用的固定套餐。

普通工具错误返回给模型自行处理；取消、审计写入失败或执行环境失效等系统错误终止 Invocation。工具首版顺序执行，不引入并行副作用。

`read` 扩展为支持图片内容。浏览器能力暂不在本次基座设计中决定，由 Comparison 业务层另行设计和注入。

## 5. 上下文管理决策

首版直接复用 Pi 的上下文压缩机制，并做 Reprise 适配。采用“压缩取代滚动截断”：上下文接近容量时，先摘要旧历史，再移除旧消息；不得静默删除未经摘要的历史。

### Pi 机制保留

- 根据上下文窗口和预留空间自动触发；
- 使用实际 usage，必要时估算新增消息；
- 摘要与最近完整消息共同保留；
- 在安全切点截断，不能拆开 tool call/tool result；
- 超长 turn 生成 turn prefix summary；
- previous summary 与新增历史合并；
- 摘要生成失败、输出被截断时不提交摘要；
- 文件读取和修改信息尽量保留在摘要中。

### Reprise 适配

- 公共接口改为 Provider 无关的 `AgentHost`/`AgentSession`；Pi 类型仅存在 Provider Adapter 和内部转换层；
- 压缩结果写入现有 Experiment `events.jsonl` 的 audit sink，不引入 Pi Session 文件作为第二事实源；
- 先生成摘要并成功记录审计，再替换内存工作集；失败不提交半成品；
- 压缩使用当前 Invocation 的 signal 和统一错误语义；
- 支持一次 Invocation 内在安全边界多次压缩；
- 角色只提供压缩重点，基座负责容量计算、触发、切点、摘要调用和应用；
- 摘要至少保留目标、约束、已确认事实、已完成动作、工作路径、待检查项、阻塞原因和可重新读取的材料入口；
- 压缩失败时明确返回失败，不降级为静默滚动截断。

压缩策略接口保持最小化：

```ts
type CompactionPolicy = {
  reserveTokens: number;
  keepRecentTokens: number;
  instructions?: string;
};
```

容量参数由 Host 根据 Provider 能力装配，角色只补充保留重点。

## 6. Codex 机制的采纳范围

当前没有足够公开依据支持复制 Codex 内部的专用摘要算法或不可见服务端状态。因此不假设 Codex 与 Pi 的内部实现相同。

已采纳的有效原则只有：

> 用压缩保留旧历史中的有效信息，取代直接滚动删除旧消息。

自动触发、摘要加近期尾部、增量摘要、安全切点等机制在本项目中明确归为 Pi 已有能力，不包装成额外的 Codex 实现。

模型推理强度等 Provider 参数不进入业务 Agent 接口，由 Provider Adapter 映射。工具仍顺序执行，不用并行工具弥补上下文不足。

## 7. 实施时需要修改的部分

1. 将公共 Host/Session 命名和类型改为 Provider 无关；
2. 从 Pi 代码中提取或复用 compaction、切点、摘要和文件操作追踪逻辑；
3. 建立 Provider Adapter，隔离 Pi 消息类型和模型调用 API；
4. 扩展 AgentSession 的 Freeform 工作请求；
5. 接入 Invocation 生命周期、取消、错误和并发约束；
6. 将 Session/Invocation/message/tool/model/compaction 事实写入统一 audit sink；
7. 验证中文、图片、超大工具结果和多轮压缩的 token 估算误差；
8. 固定所复用 Pi 代码的版本或 commit，并核对许可证与声明要求。

## 8. 暂不做的事情

- 进程崩溃后的 Session 续跑；
- 通用浏览器工具设计；
- 独立摘要 Agent 或第二套业务状态机；
- 并行工具调度；
- Provider 专用参数泄漏到 Agent 公共接口；
- 用摘要替代原始事件和 artifact；
- 业务层自行复制模型 loop。

## 9. 待继续讨论

后续需要细化：

- Provider Adapter 的最小接口；
- AgentSession 的消息块和图片输入模型；
- Compaction 事件结构和模型输入复原；
- 工具结果截断与继续读取协议；
- Session/Invocation 的具体 TypeScript API；
- Pi 代码复用的目录、版本和许可证落点。

## 10. Provider Adapter 决策

采用“Reprise 包装层 + Pi Agent Core”方案，不复制 Pi 的 Agent loop。

```text
AgentHost → AgentSession → PiProviderAdapter → Pi Agent → Pi AI → Provider
```

`AgentHost` 和 `AgentSession` 是公共 Provider 无关接口；Pi 类型只出现在 `infrastructure/agent/providers/pi/` 及其内部转换层。Adapter 负责创建和配置 Pi Agent、订阅 Pi 事件、适配工具和消息、映射结果；不负责 Reprise 的业务编排、Session/Invocation 身份、Experiment 持久化或业务 Schema。

Pi 已有的 Agent loop、流式处理、工具调度和上下文能力优先通过依赖复用。只有公开扩展点无法满足 Reprise 要求时，才局部接管或维护补丁。

## 11. 工作委托和生命周期

`work()` 和 `request()` 都代表一次完整工作委托，可在内部包含多个 Pi turn、模型请求、工具调用和上下文压缩。Pi Agent 自然结束当前 prompt 的 loop，才表示该 Invocation 的委托完成；不把模型自称完成、工具调用次数或文件变更解释为业务完成。

`request()` 在 Pi loop 自然结束后提取结构化结果，执行 JSON 解析、normalize、Schema 校验、业务 validate 和有界 repair。repair 追加到同一 Invocation、同一 AgentSession；校验成功、不可恢复失败或取消后 Invocation 才结束。

基座不判断 Controller、Comparison 或 Recovery 的业务停止条件。Pi 的 stop hook 仅用于取消、Session 关闭、Provider 故障、审计失败和安全边界；是否继续下一轮由业务 Agent/application 决定。

## 12. 消息和图片模型

公共 API 只暴露最小工作请求和图片引用，不允许业务层伪造完整 assistant/tool transcript。AgentSession 内部复用 Pi 的 `AgentMessage`、内容 block、toolCallId 和 Agent 事件；Provider Adapter 负责必要转换。

`read` 支持图片内容。图片模型格式直接复用 Pi 的 `ImageContent`；Reprise 额外维护 artifact 身份、ownership、contentHash、byteLength 和持久化。发送前由 Host/ArtifactResolver 校验引用、读取原文并转换为 Pi 图片 block。模型不可见 artifact 元数据不发给模型。

事件记录 artifactId、mediaType、contentHash、byteLength；原始图片按受控 artifact/附件机制保存，超过内联上限时不复制到事件正文。重建模型输入时校验 hash 和长度，再转换为 Pi 图片 block。压缩摘要不嵌入图片二进制。

## 13. Pi 事件到 Reprise 审计

只将稳定且可复原的语义映射为 Reprise 事件：

- Agent 开始/结束 → `agent.invocation_started` / `agent.invocation_completed`；
- 完整 user/assistant/tool 消息 → `agent.message_appended`；不逐 delta 持久化；
- 工具开始/结束 → `agent.tool_called` / `agent.tool_completed` 或 `agent.tool_failed`；
- 模型请求和原文 → `agent.model_request` / `agent.model_output`；
- provider retry → `agent.request_retried`；
- 压缩 → `agent.context_compacted`；
- 取消和错误 → `agent.invocation_cancelled` / `agent.invocation_failed`。

`turn_start`、`turn_end`、流式 delta 和工具进度可供内部安全切点或实时 UI 使用，不直接成为业务协议。Experiment `events.jsonl` 是唯一持久化事实源，Pi transcript 只是内存工作集。

## 14. 待继续讨论

下一步讨论 AgentHost/AgentSession 的错误语义和失败分类，包括模型输出非法、工具错误、Provider 暂时故障、取消、审计失败和 Session 生命周期错误。

## 15. 审计与模型输入复原

Experiment `events.jsonl` 是唯一持久化事实源。每次 Invocation 记录实际 user prompt、完整稳定消息、tool call/result 配对、provider request、model output、retry、repair、compaction 和最终状态。事件至少带 `sessionId`、`invocationId`、顺序号、内容 hash 与 byteLength；大正文和图片使用受控 artifact 引用。

重建模型输入时按事件顺序读取消息和附件，校验 contentHash/byteLength，再恢复为 Pi 消息 block。不能只保存摘要、路径或 digest，也不能让 Pi Session 文件成为第二事实源。流式 delta 和实时 UI 事件不逐条持久化，稳定消息结束时写入完整内容。

## 16. 工具结果与超大输出

复用 Pi 的 content block 和截断思路。工具结果按字节/行数限制后再送模型，截断必须明确标记并提供稳定的继续读取入口；完整原文保存为受控 artifact。审计同时保留原始 artifact 引用和实际发送给模型的截断版本。

普通工具错误作为 `tool_result` 返回模型自行处理；系统错误才终止 Invocation。截断不能破坏 toolCallId 配对，也不能静默丢弃唯一事实。

## 17. Provider 能力与模型配置快照

`model` 是 `AgentHost.createSession` 必填项。Session 创建时冻结模型配置快照，参考 Pi 的模型描述，至少包含：

```ts
type ModelConfigSnapshot = {
  provider: string;
  modelId: string;
  api: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: readonly ("text" | "image")[];
  reasoning: boolean;
  reasoningLevel?: string;
  adapterVersion: string;
  configDigest: string;
};
```

认证密钥、完整请求头和敏感配置不进入快照。Provider Adapter 根据快照能力执行图片输入、输出上限、推理设置和兼容参数映射。业务 Agent 不依赖 Provider 字段。

## 18. 测试和 Provider 替换边界

默认测试使用 fake Provider Adapter，不访问真实模型、不产生费用。基座测试覆盖：流式消息、工具往返与顺序、图片输入、超大结果截断、retry、timeout、cancel、context compaction、structured repair、并发保护、事件日志复原和失败分类。

真实 Provider 只通过显式 opt-in smoke gate 验证。替换 Provider 时，业务 Agent 和 `AgentHost/AgentSession` 公共 API 不变，只替换 `providers/<name>/adapter` 及其映射测试。

Pi 优先通过依赖复用：消息 block、工具循环、流式事件、截断思路、模型能力描述和压缩算法。Reprise 自己保证事件日志唯一事实源、artifact 校验、权限、Invocation 生命周期、业务 Schema、审计失败语义和 Provider 无关公共 API。

## 19. 剩余待审核事项

当前设计还需明确的主要是：

1. `AgentHost`/`AgentSession` 公共 API 的最终 TypeScript 类型和目录落点；
2. 事件 envelope 的字段命名、版本策略和 schema 校验范围；
3. 工具结果截断阈值和 artifact 内联上限；
4. Provider Adapter 与 fake adapter 的测试契约；
5. Pi 依赖版本、源码复用许可和升级策略。

## 20. 实现前兼容性核对结论

已核对锁定依赖 `@earendil-works/pi-agent-core@0.84.1` 与 `@earendil-works/pi-ai@0.84.1`，两者为 MIT License。

公开 `Agent` API 支持：

- 同一实例多次 `prompt()`，可承接连续 Session；
- `subscribe()` 订阅 Agent、turn、message 和 tool execution 事件；
- `abort()` 与 `waitForIdle()` 取消和等待；
- `toolExecution: "sequential"` 顺序工具执行；
- 消息 block、图片输入和工具调用；
- `transformContext` 等上下文变换扩展点；
- 导出的 `prepareCompaction`、`compact`、`generateSummary`、安全切点和 token 估算函数。

禁止使用 `AgentHarness` 作为 Reprise 的执行或持久化入口；0.84.1 中 Harness 的 `prompt`、`compact`、`resume` 是未实现占位。Pi 的 Agent transcript 只作为内存工作集，Reprise events.jsonl 仍是唯一事实源。

因此首版实施路径为：

1. `PiProviderAdapter` 直接包装公开 `Agent`；
2. 通过 `prompt()` 实现同一 Session 的多次 `work()`/`request()`；
3. 通过 `subscribe()` 映射稳定消息、工具、模型和失败事件；
4. 固定 `toolExecution: "sequential"`；
5. 通过导出的 compaction API 接入 Reprise Context Manager；
6. 使用 `abort()`/`waitForIdle()` 实现取消和清理；
7. 若公开扩展点不足，只局部复制必要模块，保留上游版本、commit 和 MIT 声明。

不复制整个 Pi 源码，不修改 `node_modules`，不让 Pi 类型进入业务 Agent 公共接口。升级依赖时先审阅变更，再运行 Agent 基座和三个角色的回归测试。
