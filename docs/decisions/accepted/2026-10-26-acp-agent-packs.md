# 决策：以共享 ACP 层接入国产编码 Agent 候选 Runtime

状态：accepted

## 问题

dsh（DeepSeek Harness）、Kimi Code、MiniMax Code（mcode）、Qwen Code 都要作为候选 Runtime 进入对照。四家都原生提供 Agent Client Protocol v1（stdio 上的换行分隔 JSON-RPC），但 CLI 入口、本地数据目录和鉴权文件各不相同：`dsh --profile acp`、`kimi acp`、`mcode acp`、`qwen --acp`（布尔开关，不是子命令）。

如果按产品各写一份协议客户端，同一套握手、通知映射和结算逻辑会存在四份；如果驱动 TUI（pty 注入），候选的可见输出和轮次终态只能靠截屏或启发式解析推断，无法作为证据。

## 决定

只走 ACP stdio。不驱动 TUI，不用 `qwen serve` 这类实验性 HTTP 入口，也不在应用层按 `productId` 分支。

共享层放在 `src/products/shared/acp/`：`client.ts`（JSON-RPC 与权限应答）、`events.ts`（`session/update` 映射）、`settlement.ts`（`stopReason` 映射）、`runner.ts`、`history.ts`、`projection.ts`、`runtime.ts`、`pack.ts`。每个产品的 Pack 只是 `createAcpPack()` 的一份声明：可执行文件名、覆盖用环境变量、ACP argv、数据根、鉴权文件、默认候选和 recovery 文本。

能力声明如实反映 ACP 的边界：`nativeAdmission: false`、`clientMessageId: false`、`nativeTurnSettlement: true`、`tokenTelemetry: 'none'`、`reconnectSession: false`、`querySubmissionByClientId: false`、`confirmProcessTermination: true`。`DeliveryReceipt.evidence` 固定为 `preflight`：ACP 没有可关联的客户端消息 ID，不伪装成 admission 回执。

轮次终态来自 `session/prompt` 的响应，属于原生结算：`end_turn` → completed，`cancelled` → aborted，`max_tokens`/`max_turn_requests`/`refusal` → failed（upstream）。缺失或未识别的 `stopReason` 记为 `runtime_failed`，不猜测成功。工具事件按轮作用域定 id（`<turnId>:<callId>`）；轮次结算后到达的终态更新在作用域内没有对应的 `tool_started`，直接丢弃：该轮证据已经记录，把它挂到下一轮会让下一轮复用同一 `callId` 的真事件被当成重复吞掉。唯一的例外是 Host 自己观察到的权限拒绝。

自动化客户端必须应答 `session/request_permission`，否则轮次永久阻塞。共享层取第一个 `allow*` 选项；没有 allow 选项时回 `cancelled` 而不是挂起。这等于放宽了审批门，因此写进 `ExecutionBoundary.limitations`，不能只藏在实现里。拒绝要留痕：答 `cancelled` 时记一条 `runtime.tool_finished`（`status: 'failed'`、`permissionDecision: 'cancelled'`），comparison 的 `rejectedApprovals` 由该事件推导而不是硬编码 0；允许的请求不记，因为每个工具都会重复一次，且已由 `ExecutionBoundary.limitations` 声明。客户端不声明文件系统、终端或 elicitation 能力，非权限类的 agent 请求一律回 JSON-RPC `-32601`，让 agent 用自己的工具。

模型目录只发布一个 offer：ACP 没有列举模型的方法，但 `session/new` 的响应里各家都以不同形状报出了当前模型（dsh 的 `configOptions`、qwen 的 `models.currentModelId`、mcode 的编码式 config option）。归一化这些形状等于按产品分支并猜测语义，所以不建真目录：`listCatalog()` 把该 Pack 声明的默认候选作为唯一 offer 发布（值取 `requestedModel`），`validateCandidate()` 不做目录核对，`resolvedModel` 记为 `unknown`。发布空集会被 TUI 读成"该产品没有模型"（空 catalog 是错误态），而"无法枚举"与"没有模型"不是同一件事。`session/prompt` 本身不带模型字段，选中的模型不会传给 agent，agent 用自己的默认模型；这条写进 `ExecutionBoundary.limitations`，不留给用户猜。

`resolvedModel: 'unknown'` 是事实而非缺省，所以两条捷径都被否掉：把 `requestedModel` 回填成 `resolvedModel` 会让报告谎称模型被解析过；把共享门禁整体放宽会让能校验身份的运行时也失去保护（codex / claude-code 仍然必须拒绝 `unknown`）。改用一条产品无关的可选端口声明：`ProductRuntime.verifiesModelIdentity?(): boolean`，语义是"该运行时能否说出实际服务的模型"，缺省视为能。`AcpProductRuntime` 实现并返回 `false`，admission（`resolveVerifiedCandidate()`）只对这种声明放行 `unknown`，其余分支的错误文案与行为不变。该声明不进 `ResolvedRuntime`，持久化形状不变，也不需要 schema 迁移。

本批只声明 `runtime` 能力。历史读取降级为可解释的空结果：`discover()` 返回空集并附 `catalog-unavailable` 诊断，`inspect()`/`import()` 明确拒绝。空集加诊断的含义是"本 Pack 还读不了"，不是"该产品没有会话"。

环境选择新增 `acp` 角色，只透传已验证存在的 `MINIMAX_DATA_DIR`；其余三个 CLI 从 home 解析自己的配置，基础变量集已经覆盖。`candidateExecutionPlan()` 的 role 参数放宽为 `ProcessEnvironmentRole`，ACP 的 `controls` 只声明 `persistent-session`。

## 备选方案

**每个产品一份协议客户端。** 四份重复的握手、通知映射和结算逻辑，改一处协议细节要同步四次，拒绝。

**pty 注入驱动 TUI。** 可见输出和终态都变成屏幕猜测，还要跟随各家的界面改动；与"进入模型请求的输入必须能从事件日志复原"冲突，拒绝。

**用 `qwen serve` 的实验性 HTTP。** 没有稳定契约，也不能覆盖另外三家，拒绝。

**一个按 `productId` 分支的万能 Pack。** 违反 `src/AGENTS.md` 的平台与 Pack 边界，拒绝。

**为统一而虚构模型目录或 token 用量。** 会让报告出现无法追溯的数字，拒绝。

## 影响

新增 ACP 产品只需一份声明加一份 recovery 文本，协议行为只在共享层演进。四家的差异被限制在可执行文件、argv、数据根和鉴权文件四项，评审时可以逐项核对。

历史导入、token 计量和会话恢复仍是空白：这四家的报告只会有轮次终态和可见输出，不会有成本数据。真实 Runtime 兼容性仍需显式 opt-in 的实跑验收，离线测试不替代它。Windows 11 仍是唯一已验证平台。

## 验证

离线测试覆盖 `session/update` 到事件的映射（含工具终态只结算一次）、`stopReason` 到结算的映射、权限请求自动应答、连续三轮的可见输出与按轮作用域的 `toolCallId`（同一轮重复终态只记一次）、`stop()`/`close()` 的事件顺序与临时目录清理，以及历史降级的诊断；`plan` 更新只落 `entries[].content` 文本、无 allow 选项的权限请求回 `cancelled` 且 `rejectedApprovals` 为 1、结算后迟到的工具更新不会吞掉下一轮复用同一 `callId` 的事件，各有一条用例；TUI 层另有两条用例：一条走真实 workflow 证明 ACP 目录不再是空集，一条走真实 workflow 与真实 `resolveVerifiedCandidate` 证明目录就绪后 Enter 能走到启动确认，且此时 `resolvedModel` 仍是 `unknown`；假 ACP agent 用 `process.execPath` 加临时脚本启动，不产生外部调用。端口声明带两条反向用例：真实 `AcpProductRuntime`（声明不校验）配 `unknown` 必须放行；一个不实现该声明的最小假 Runtime 配 `unknown` 必须仍然抛出 `Candidate model is not verified by the target runtime.`。把门禁改回无条件拒绝会让前一条失败，把门禁整条删掉会让后一条失败，所以两个方向都钉住了。其中两条用例把 `AcpTargetRunner` 接到真实的 `createCandidateRuntimeSink` + `ExperimentStore` 上：只有这条路径会校验事件与 Journal 的归属关系，桩 sink 会放过不合法的 payload。`toolCallId` 作用域与 stderr 脱敏两条断言都做过反向验证：去掉作用域、或把 stderr 改回原文累积，用例即失败。真实 Runtime 调用仍需环境变量显式 opt-in。本批对 dsh 0.2.1-rc.2、mcode 0.6.13、qwen 0.26.1 各做过一次真实 `initialize` + `session/new` 握手（不发送 prompt，不产生模型费用）；kimi 2.1.1 的握手在 `session/new` 被 `-32000 Authentication required` 拒绝，说明配置文件存在不等于已登录。四家本机模型配置的 one-shot 实跑不属于这条门禁。
