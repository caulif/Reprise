# 多产品 Agent Pack 开发规划（dsh / Kimi Code / MiniMax Code / Qwen Code）

状态：规划稿，未实施
编写时间：2026-10-26
分支：`feat/agent-packs`（从 `main` 切出）

## 1. 目标

让 Reprise 把这四个外部编码 Agent 当成一等候选 Runtime 接入：能在候选列表里发现、探测可用性、校验模型、驱动多轮、等待原生结算、投影用户可见时间线。

四个产品都原生提供 ACP（Agent Client Protocol over stdio），所以共享一层 ACP 客户端，而不是写四份协议实现。

非目标（本阶段不做）：

- 不做 OpenCode / MiMo Code（HTTP+SSE 面，另立 P2）和 Trae Agent（one-shot，另立 P3）。
- 不驱动任何 TUI（pty 注入）。TUI 无稳定输入契约，事件与结算无法复原。
- 不改 `src/core/runtime.ts` 的端口，除非 P0 实测证明现有字段不够。
- 不做 Codex / Claude Code 的等价改造；两个现有 Pack 保持不动。

## 2. 现状基线

扩展点是现成的，不需要先动核心：

- [`ProductRuntime`](../../src/core/runtime.ts) 负责探测、目录、校验、Runner 创建、Recovery 能力声明。
- [`ProductPack`](../../src/products/contract.ts) 是 history / runtime / projection 三端口。
- 已有两个先例：`src/products/packs/codex`（约 2500 行）、`src/products/packs/claude-code`（约 1610 行）。规模构成可参考：`sessions.ts` 600+ 行是历史解析，`runner.ts` 435–482 行是协议客户端。
- 第三方 Pack 可只靠 `{dataDir}/plugins.json` + `@caulif/reprise/pack-api` 加载，不改宿主（见 [架构总览](../architecture/overview.md)）。

结论：本规划只需要在 `src/products/` 下新增代码，属于纯加 Pack。

## 3. 本机环境快照（2026-10-26 实测）

| 产品 | 命令 | 版本 | 多轮控制面 | 批处理 | 本机状态 |
|---|---|---|---|---|---|
| DeepSeek Harness | `dsh` | 0.2.1-rc.2 | `dsh --profile acp`（stdio，无参数） | `dsh --profile headless [--json] [--session-id <id>] [task\|-]` | 已装，`~/.dsh/.credentials.yaml` 存在，profiles 含 `acp`/`headless` |
| Kimi Code | `kimi` | 2.1.1 | `kimi acp`（stdio） | headless | 已装，`~/.kimi-code/` 有 `config.toml`、`server.token`、`sessions/` |
| MiniMax Code | `mcode` | 0.6.13 | `mcode acp`（stdio） | `mcode exec [prompt]` | 本次新装，`~/.mcode` 不存在，未登录 |
| Qwen Code | `qwen` | 0.26.1 | `qwen --acp`（布尔开关，进 ACP 模式） | 位置参数即 one-shot；`-p` 已废弃；`qwen serve` 实验性 HTTP daemon | 本次新装，`~/.qwen` 不存在，未登录 |

凭据现状：环境里没有任何 `*_API_KEY`（DEEPSEEK / MINIMAX / QWEN / DASHSCOPE / OPENAI / MOONSHOT 均缺失）。dsh 与 kimi 看起来已登录；mcode 与 qwen 需要先跑各自的登录/配置流程，否则只能测「未认证」路径。

## 4. 总体设计

### 4.1 共享 ACP 层

新增 `src/products/shared/acp/`（与 `shared/session-source.ts` 同级，仍在 products 层内，符合分层导入规则）：

| 文件 | 职责 |
|---|---|
| `client.ts` | JSON-RPC 2.0 over stdio，NDJSON 分帧；请求关联、超时、取消、进程退出归因 |
| `session.ts` | ACP 会话 → `CandidateSessionHandle`；`start` / `send` / `resume` |
| `events.ts` | `session/update` 通知 → `runtime.*` TargetEvent（纯函数） |
| `settlement.ts` | prompt 响应 `stopReason` → `TurnSettlement`（纯函数） |
| `capabilities.ts` | ACP 能力 → `RuntimeCapabilities` 声明 |

方法名、帧结构以 [Agent Client Protocol](https://agentclientprotocol.com/) 官方规范为准。**实现前先把 spec 读一遍并固化成测试 fixture**，不靠记忆写协议。

### 4.2 端口映射

| `TargetRunner` / 能力 | ACP 来源 | 说明 |
|---|---|---|
| `start` / `send` | `session/new` / `session/prompt` | `DeliveryReceipt.evidence` 用 `rpc_response`，请求 id 即 `clientMessageId` |
| `waitForTurn` | `session/prompt` 的响应 | `stopReason` 映射 completed / aborted / failed |
| `visible_output` | `session/update` 的 agent message chunk | 只取已公开文本，不伪造 reasoning |
| `tool_started` / `tool_finished` | `session/update` 的 tool call / update | 经 `shared/public-live-map.ts` 映射成 live 摘要 |
| `usage_reported` | usage 字段（若有） | `tokenTelemetry: 'partial'` |
| 审批 | `session/request_permission`（agent → client） | **必须由 client 自动应答**，否则永久挂起 |
| `reconnectSession` | `session/load` 或产品侧 session id | 未在 spec 中统一时按产品降级为 `false` |

`confidence` 目标是 `'native'`：四家都通过 ACP 暴露回合结束原因。

### 4.3 每个 Pack 的文件构成

照抄现有 Pack 形状，保持可对照：

```text
src/products/packs/<product>/
├── pack.ts                 # manifest（apiMajor: 3, capabilities）、装配三端口、defaultCandidate
├── runtime.ts              # inspectAvailable / inspectAvailability / resolve / validateCandidate / listCatalog / recoveryCapabilities
├── runner.ts               # TargetRunner 实现；ACP 产品只做参数与装配，逻辑在 shared/acp
├── protocol.ts             # 帧 → TargetEvent 的纯映射，便于单测
├── sessions.ts             # 历史发现与解析（P0 先返回空集 + diagnostics，P1 再补）
├── projection.ts           # UserSurfaceProjection
├── historical-artifacts.ts # 可先缺省
├── recovery/SKILL.md       # Recovery playbook
└── smoke-gate.ts           # 真实调用门禁（opt-in）
```

产品专属差异只允许出现在这几个文件里。应用层与 TUI 不按 `productId` 分支（见 `src/AGENTS.md`）。

## 5. 分期

| 阶段 | 内容 | 预估 | 产出 |
|---|---|---|---|
| P0-0 | **协议 spike**：四个产品各跑一次「初始化 → 双轮对话 → 同 session 续接 → 自动审批」，记录实际方法名、帧样例、失败形态 | 1 天 | 追加到本文第 8 节的能力矩阵 |
| P0-1 | `shared/acp/` 全套 + **dsh pack**（`--profile acp`），含假 ACP server 测试 fixture | 5–7 天 | 可跑通的第一个候选 |
| P0-2 | **kimi pack**（`kimi acp`），复用共享层 | 2–3 天 | |
| P0-3 | **mcode pack**（`mcode acp`） | 2–3 天 | |
| P0-4 | **qwen pack**（优先 `qwen --acp`；若 ACP 不完整则退回 `qwen serve` HTTP 或官方 TS SDK） | 2–4 天 | |
| P1（可选） | 历史导入：dsh `~/.dsh/sessions`、kimi `~/.kimi-code/sessions`、mcode 与 qwen 的落盘位置 | 每个 3–5 天 | 历史发现 + 导入 + 投影 |

P0-1 是唯一的硬依赖。P0-2/3/4 之间互不依赖，可以并行，但都不得复制 `shared/acp` 的逻辑。

## 6. 门禁与测试

按仓库规则执行，不新造流程：

- 改代码后 `npm run check`；只改文档时 `npm run verify:docs`。
- 新增门禁必须同批附一个能让它失败的自动化用例。
- 覆盖率阈值只升不降。
- 真实 Runtime 调用必须显式 opt-in（环境变量），默认路径不产生外部费用。

测试分层：

1. **纯函数单测**：`protocol.ts` / `events.ts` / `settlement.ts` 的帧映射，用抓下来的真实帧做 fixture。
2. **假 ACP server 集成测**：用 `node:child_process` 起一个脚本化的 stdio server，覆盖握手、双轮、审批自动应答、异常退出、超时。
3. **真实 smoke**：`smoke:acp:dsh`、`smoke:acp:kimi` 等，opt-in 且默认不进 CI。
4. **反向用例**：故意让审批不自动应答，断言门禁变红；故意删 `apiMajor`，断言 registry 拒绝加载。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `session/request_permission` 挂起 | Runner 永久等待，回合超时 | 共享层默认自动批准，策略可配；单测覆盖「无应答必须报错而不是挂死」 |
| ACP 规范漂移 / 各家方言 | 帧解析断裂 | 帧映射纯函数化 + 每家 fixture；版本号写进 Pack manifest |
| Windows 启动形态 | npm 全局装的是 `.cmd` shim，`spawn` 直接失败 | 统一走 `spawnRuntimeProcess`；四个产品各留一条 Windows smoke |
| qwen `serve` 仍标 experimental | HTTP 路径不稳定 | 优先 ACP 路径；HTTP 只作退路 |
| mcode / qwen 未登录 | 无法跑真实 smoke | 先落「未认证」错误路径（`RuntimeFailureKind: 'authentication'`），登录后补 smoke |
| 各家 session 落盘格式未知 | P1 历史导入不可估算 | P0 只做 runtime；P1 前先做一次格式勘察 |
| 会话续接语义不一致 | 多轮可比性受损 | P0-0 矩阵必须实测；不满足 `reconnectSession` 的产品显式降级为 `false`，不伪装 |

## 8. 能力矩阵（P0-0 待填）

| 产品 | 握手方法 | 双轮可行 | 同 session 续接 | 审批自动应答 | 结算来源 | 结论 |
|---|---|---|---|---|---|---|
| dsh | 待实测 | 待实测 | `--session-id` 已确认存在 | 待实测 | 待实测 | |
| kimi | 待实测 | 待实测 | 待实测 | 待实测 | 待实测 | |
| mcode | 待实测 | 待实测 | 待实测 | 待实测 | 待实测 | |
| qwen | 待实测 | 待实测 | 待实测 | 待实测 | 待实测 | |

## 9. 验收标准

1. TUI 候选列表出现 4 个新 productId；未安装时显示 `not_installed` 且带 `installHint`。
2. 每个 Pack 能跑通一次真实双轮 smoke：第一轮 `completed`，第二轮在同一 session 内继续并再次 `completed`。
3. `TurnSettlement.confidence` 为 `native`，且回合事件可从事件日志复原（含 prompt 与可见输出）。
4. 审批不会挂起：自动批准路径有单测，无应答路径有失败断言。
5. 未登录/断网返回 `authentication` 或 `upstream` 类失败，不挂死、不静默成功。
6. `npm run check` 全绿；新增门禁带反向用例；覆盖率不降。

## 10. 回滚

改动全部是新增目录（`src/products/packs/{dsh,kimi,mcode,qwen}`、`src/products/shared/acp`）加注册点。回滚方式是移除注册与目录，不触碰现有 Pack 与核心端口。也可以用 `{dataDir}/plugins.json` 临时停用某个产品而不改代码。

## 11. 待你确认的两件事

1. **凭据**：mcode 与 qwen 需要登录。是我起交互式登录流程（会弹浏览器/设备码），还是你手动登录后我再跑 smoke？
2. **历史导入范围**：P0 只做驱动（`capabilities: ["runtime"]`），还是同步做历史发现（`"import"`）？前者 3 周内可交付，后者翻倍。
