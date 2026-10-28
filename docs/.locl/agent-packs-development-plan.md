# 多产品 Agent Pack 实施记录（dsh / Kimi Code / MiniMax Code / Qwen Code）

状态：已实施（`feat/agent-packs`，PR #185）
编写时间：2026-10-26（实施后按实际落地内容修订）
分支：`feat/agent-packs`（从 `main` 切出）

本文是开发过程的记录，不是契约。行为与边界以 [决策：以共享 ACP 层接入国产编码 Agent 候选 Runtime](../decisions/accepted/2026-10-26-acp-agent-packs.md) 和代码为准；两者不一致时改本文。

## 1. 目标

让 Reprise 把这四个外部编码 Agent 当成一等候选 Runtime 接入：能在候选列表里发现、探测可用性、驱动多轮、等待原生结算、投影用户可见时间线。

四个产品都原生提供 ACP（Agent Client Protocol over stdio），所以共享一层 ACP 客户端，而不是写四份协议实现。

非目标（本阶段未做）：

- OpenCode / MiMo Code（HTTP+SSE 面）和 Trae Agent（one-shot）。
- 不驱动任何 TUI（pty 注入）。TUI 无稳定输入契约，事件与结算无法复原。
- 端口只新增一条可选声明（`ProductRuntime.verifiesModelIdentity?()`），不新增必填字段、不改既有字段与持久化形状。
- 不做 Codex / Claude Code 的等价改造；两个现有 Pack 未改动。
- 不做历史导入：四个 Pack 只声明 `runtime` 能力。

## 2. 现状基线

扩展点是现成的，不需要先动核心：

- [`ProductRuntime`](../../src/core/runtime.ts) 负责探测、目录、校验、Runner 创建、Recovery 能力声明。
- [`ProductPack`](../../src/products/contract.ts) 是 history / runtime / projection 三端口。
- 已有两个先例：`src/products/packs/codex`、`src/products/packs/claude-code`。
- 第三方 Pack 可只靠 `{dataDir}/plugins.json` + `@caulif/reprise/pack-api` 加载，不改宿主（见 [架构总览](../architecture/overview.md)）。

结论：本批只新增 `src/products/` 下的代码加一个注册点。

## 3. 控制面形态（2026-10-26 实测）

| 产品 | 命令 | 版本 | 多轮控制面 |
|---|---|---|---|
| DeepSeek Harness | `dsh` | 0.2.1-rc.2 | `dsh --profile acp`（stdio，无参数） |
| Kimi Code | `kimi` | 2.1.1 | `kimi acp`（stdio） |
| MiniMax Code | `mcode` | 0.6.13 | `mcode acp`（stdio） |
| Qwen Code | `qwen` | 0.26.1 | `qwen --acp`（布尔开关，进 ACP 模式） |

四家都原生提供 ACP，上表版本即实测握手的版本。登录状态、凭据与模型配置属于机器状态，不进仓库，也不属于门禁；Reprise 不读取、不复制、不改写它们。

## 4. 落地结构

### 4.1 共享 ACP 层

`src/products/shared/acp/`（仍在 products 层内，符合分层导入规则）：

| 文件 | 职责 |
|---|---|
| `client.ts` | JSON-RPC 2.0 over stdio，NDJSON 分帧；请求关联、超时、进程退出归因、stderr 脱敏摘要 |
| `runner.ts` | `AcpTargetRunner`：`initialize` → `session/new` → `session/prompt`；按轮作用域 `callId`；结算前冲净在飞写入 |
| `events.ts` | `session/update` 通知 → `runtime.*` TargetEvent（纯函数，只有文本进 Journal） |
| `settlement.ts` | prompt 响应 `stopReason` → `TurnSettlement`（纯函数） |
| `history.ts` | 历史降级：空集 + `catalog-unavailable` 诊断，`inspect`/`import` 明确拒绝 |
| `projection.ts` | `UserSurfaceProjection`：只从 `visible_output` 文本与 `tool_started` 取证 |
| `runtime.ts` | `AcpProductRuntime`：探测、resolve、执行计划、Runner 装配 |
| `pack.ts` | `createAcpPack()`：把一份声明装配成 `ProductPack` |

没有独立的 `session.ts` / `capabilities.ts`：会话生命周期在 `runner.ts`，能力声明是 `runner.ts` 里的常量对象。

### 4.2 端口映射（实际值）

| `TargetRunner` / 能力 | ACP 来源 | 实际实现 |
|---|---|---|
| `start` / `send` | `session/new` / `session/prompt` | `DeliveryReceipt.evidence` 固定 `preflight`；ACP 没有可关联的 admission 回执，不伪装 |
| `waitForTurn` | `session/prompt` 的响应 | `end_turn` → completed，`cancelled` → aborted，`max_tokens`/`max_turn_requests`/`refusal` → failed(upstream)，未识别 → `runtime_failed` |
| `visible_output` | `session/update` 的 agent message chunk | 只取 `content.text`；图片/资源 blob 与 agent 自己的 `messageId` 都不入库 |
| `tool_started` / `tool_finished` | `session/update` 的 tool call / update | `callId` 按轮作用域（`<turnId>:<callId>`），同一轮重复终态只记一次；结算后迟到的终态在作用域内没有 `tool_started`，直接丢弃 |
| `tokenTelemetry` | 无 | `'none'`：ACP 这里没有 usage 上报，token 与成本是未知而不是 0 |
| 审批 | `session/request_permission`（agent → client） | 自动取第一个 `allow*` 选项，无 allow 则回 `cancelled`；写进 `ExecutionBoundary.limitations` |
| 非权限类 agent 请求 | 任意方法 | 回 JSON-RPC `-32601`，不声明文件系统/终端/elicitation 能力 |
| `reconnectSession` | `session/load` 等 | `false`：一次 CandidateRun 一个会话，不续接 |
| 模型 | 无 | 不转发：`session/prompt` 没有模型字段，`resolvedModel` 记 `unknown`；`listCatalog()` 只发布该 Pack 声明的默认候选一个 offer（空目录会被 TUI 读成“该产品没有模型”） |

`confidence` 是 `'native'`：四家都通过 `stopReason` 暴露回合结束原因。

### 4.3 每个 Pack 的文件构成（实际）

```text
src/products/packs/<product>/
├── pack.ts           # 一份 AcpPackDefinition 声明 + createAcpPack()
└── recovery/SKILL.md # Recovery playbook
```

协议行为全在 `shared/acp/`，产品差异只有可执行文件名、覆盖用环境变量、ACP argv、数据根、鉴权文件、默认候选标签和 recovery 文本。应用层与 TUI 不按 `productId` 分支（见 `src/AGENTS.md`）。

注册点在 `src/products/index.ts`（`codex`、`claude-code`、`dsh`、`kimi-code`、`minimax-code`、`qwen-code`）。

## 5. 分期与完成情况

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0-0 | 协议 spike：握手、方法名、失败形态 | 完成（见第 7 节） |
| P0-1 | `shared/acp/` 全套 + dsh pack + 假 ACP agent fixture | 完成 |
| P0-2 | kimi pack | 完成 |
| P0-3 | mcode pack | 完成 |
| P0-4 | qwen pack（`qwen --acp`，未走 `serve`） | 完成 |
| P1 | 历史导入 | 未做，四个 Pack 只声明 `runtime` |

## 6. 门禁与测试

按仓库规则执行，未新造流程：

- 改代码后 `npm run check`；只改文档时 `npm run verify:docs`。
- 新增门禁必须同批附一个能让它失败的自动化用例。
- 覆盖率阈值只升不降。
- 真实 Runtime 调用必须显式 opt-in（环境变量），默认路径不产生外部费用。

实际测试分层：

1. **纯函数单测**：`events.ts` 的帧映射、`settlement.ts` 的 `stopReason` 映射。
2. **假 ACP agent 集成测**：用 `process.execPath` 起脚本化 stdio server，覆盖握手、多轮、审批自动应答、`cancelled` 结算、异常退出。
3. **真实 Journal 路径**：`test/products/acp-journal.test.ts` 把 `AcpTargetRunner` 接到真实 `createCandidateRuntimeSink` + `ExperimentStore`；桩 sink 会放过不合法的 payload，只有这条路径会校验事件归属。
4. **反向用例**：去掉 `callId` 的按轮作用域、或把 stderr 改回原文累积，对应用例即失败。
5. **真实 smoke**：未进 CI，见第 7 节。

## 7. 能力矩阵（实测结果）

| 产品 | 握手 | 多轮 | 同 session 续接 | 审批自动应答 | 结算来源 | 结论 |
|---|---|---|---|---|---|---|
| dsh 0.2.1-rc.2 | `initialize` + `session/new` 成功 | 假 agent 三轮通过 | 不续接（`sessionCapabilities` 有 `close`/`list`/`resume`，未调用） | 已验证 | `stopReason` | 可接入 |
| kimi 2.1.1 | `session/new` 返回 `-32000 Authentication required` | 假 agent 通过 | 不续接 | 已验证 | `stopReason` | 可接入；真实握手需先登录 |
| mcode 0.6.13 | `initialize` + `session/new` 成功 | 假 agent 通过 | 不续接 | 已验证 | `stopReason` | 可接入 |
| qwen 0.26.1 | `initialize` + `session/new` 成功 | 假 agent 通过 | 不续接 | 已验证 | `stopReason` | 可接入 |

真实握手不发送 prompt，不产生模型费用。kimi 的 `-32000` 说明"配置文件存在"不等于"已登录"，这一点写进了 troubleshooting。

## 8. 验收标准（对照实际）

1. TUI 候选列表出现 4 个新 productId；未安装时 `not_installed` + `installHint`。已由 `test/products/*-pack.test.ts` 覆盖，`docs/tui-audit` 基准帧同步重生成。
2. 每个 Pack 能跑通一次双轮：假 ACP agent 覆盖三轮；真实双轮 smoke 未做（需要已登录账号与显式 opt-in）。
3. `TurnSettlement.confidence` 为 `native`，回合事件可从事件日志复原（含 prompt 与可见输出）。已覆盖。
4. 审批不会挂起：自动批准路径有单测；agent 请求非权限方法时回 `-32601`。
5. 未登录/断网返回失败而不是挂死：agent 以 JSON-RPC 错误（如 `-32000`）拒绝 `session/new` 时 `start()` 直接抛错；此时进程仍存活，因此不写任何 `runtime.*` 事件，失败只体现在 `run.outcome_created` 的 outcome 上。只有进程真的退出才归因到 `runtime_failed`。
6. `npm run check` 全绿；新增门禁带反向用例；覆盖率不降。

## 9. 回滚

改动全部是新增目录（`src/products/packs/{dsh,kimi-code,minimax-code,qwen-code}`、`src/products/shared/acp`）加注册点。回滚方式是移除注册与目录，不触碰现有 Pack 与核心端口。也可以用 `{dataDir}/plugins.json` 临时停用某个产品而不改代码。

## 10. 遗留与已决

已决：

- **历史导入范围**：本批只做驱动（`capabilities: ["runtime"]`）。历史发现返回空集 + `catalog-unavailable` 诊断，`inspect`/`import` 明确拒绝——空集的含义是"本 Pack 还读不了"，不是"该产品没有会话"。
- **凭据**：mcode 与 qwen 由本机自行登录/配置，Reprise 只检查配置文件是否存在，不读取、不复制、不代登录。
- **候选模型校验**：`AcpProductRuntime.validateCandidate()` 如实返回 `resolvedModel: 'unknown'`（ACP 没有列举或校验模型的方法，agent 自己解析模型）。已决：端口新增可选声明 `ProductRuntime.verifiesModelIdentity?(): boolean`，`AcpProductRuntime` 返回 `false`，`resolveVerifiedCandidate()` 只对这种声明放行 `unknown`；codex / claude-code 不实现它，仍然拒绝 `unknown`。不伪造 `resolvedModel`，也不放宽共享门禁（见 [决策](../decisions/accepted/2026-10-26-acp-agent-packs.md)）。

遗留（不在本 PR）：

- 历史导入（dsh `~/.dsh/sessions`、kimi `~/.kimi-code/sessions`、mcode 与 qwen 的落盘格式）。
- 真实双轮 smoke 与 token 计量：ACP 这里没有 usage 上报，报告只会有轮次终态和可见输出。
- `session/close`：在 agent 声明支持时主动关闭会话，避免留下会话记录。
- OpenCode / MiMo Code / Trae Agent。
