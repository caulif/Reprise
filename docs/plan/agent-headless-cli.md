# 无头 CLI 与 TUI 并行控制面

状态：计划。讨论稿见 [agent-headless-cli.html](./agent-headless-cli.html)。落地时改 [`src/cli/main.ts`](../../src/cli/main.ts)、[tui.md](../product/tui.md) 与 [overview.md](../architecture/overview.md) 的控制面描述，并补 `docs/decisions/accepted/`。本文不覆盖当前产品规范。

无子命令时仍启动 TUI。有子命令时走同一套 Experiment Application，不启动全屏界面。人和外部 agent 共用命令、身份和 JSON 信封；TUI 继续做最短人工路径。

## 1. 为什么可以并行

编排已经在 [`createCodexExperimentWorkflow`](../../src/application/tui-workflow.ts)：TUI 和 protocol smoke 共用 `recover` / `preflight` / `start`。CLI 是第三个调用方，不是第二套状态机。

持久化按 **Experiment 单写者**：[writer.lock](../architecture/persistence-and-crash-consistency.md#32-追加式事件与单写者) 锁的是某一个 `experiments/<id>`，不是整个 `dataDir`。因此：

- TUI 浏览 Intake、CLI 对另一会话做 recover：允许。
- TUI 与 CLI 写**同一个** Experiment：后者只读或退出码表示锁冲突，禁止抢锁。
- 两个 CLI 写两个 Experiment：允许。候选串行是产品选择，不是目录级互斥。

TUI 仍是事件日志的只读投影。CLI 写入后，History 页读磁盘即可看到新 Case / Experiment；第一版不要求 TUI 在另一进程写入时热更新时间线。

## 2. 身份

列表行不足以当冻结键。调用方必须能构造 [`SessionRef`](../../src/products/contract.ts)：

| 字段 | 谁给 | 规则 |
|---|---|---|
| `productId` | `--product` | 必填（list / recover / freeze）。会话 ID 跨产品不唯一。 |
| `sessionId` | `--session` | 必填。产品内身份。 |
| `sourcePath` | `--source-path` | 同产品同 ID 多文件时必填；`list` 的 JSON 原样带回。 |

后续步骤改用 Harness ID，不再拿产品会话 ID 开跑：

| 对象 | 标志 | 何时出现 |
|---|---|---|
| TaskCase | `--case` | `freeze` 成功之后 |
| Experiment | `--experiment` | `recover` 或 `run` 创建之后 |
| CandidateRun | `--run` | `run` 创建 Attempt 之后 |

`--data-dir` 与 TUI 相同，默认 `REPRISE_DATA_DIR` 或 `.reprise`。`--sessions-dir <productId>=<path>` 与现 CLI 相同。

## 3. 命令

无位置参数：现有 TUI。下面五个子命令覆盖用户说的路径；`status` 只读，给 agent 轮询。

```text
reprise sessions list   --product <id> [--json]
reprise sessions show   --product <id> --session <id> [--source-path <path>] [--json]
reprise recover         --product <id> --session <id> [--source-path <path>] --allow-recovery [--json]
reprise run             --case <caseId> --allow-run [--product <candidatePack>] [--model <value>] [--json] [--wait]
reprise report          --experiment <id> [--json]
reprise status          --experiment <id> [--json]
```

`freeze` 不单独作为第一版动词：`recover` 内部先 inspect/import 再冻结 TaskCase，再跑 Recovery Agent。只要会话、不要恢复时用 `sessions show`（只读，不写 Case）。

`compare` 不单独作为第一版动词：Comparison 仍挂在 CandidateRun 收尾上，与 TUI 相同。[`run --wait`](#4-run) 阻塞到 Comparison 投影落盘或失败；[`report`](#5-report) 读已有投影，不重跑模型。

与 [选候选产品与模型](./candidate-model-picker.md) 对齐：`run` 的 `--product` / `--model` 是**候选** Pack 与 `requestedModel`，不改 `TaskCase.source.productId`。省略时用该来源 Pack 的 `defaultCandidate()`。

### 3.1 `sessions list`

调用 Pack `discover`，输出 `SessionSummary` 页，不含 transcript。JSON 带 `cursor` / `diagnostics`，便于 agent 翻页（`--cursor`）。人类默认表：产品、会话 ID、时间、标题截断、readiness。

### 3.2 `sessions show`

`inspect` 一次。JSON 含 `initialInput` 候选句、signals、`recoveryReadiness`、完整 transcript **默认不倾倒**；`--transcript` 才写出。无合法用户任务句时退出码 2，与核对页「不得冻结」一致。

### 3.3 `recover`

`--allow-recovery` 才调用 Pi 上的 Recovery Agent（内部模型费用）。缺省：打印将冻结的 `SessionRef` 与费用警告，退出码 5。

校验通过的 preview 仍按[自动 accept](../decisions/accepted/2026-08-31-recovery-auto-accept-validated-preview.md) 发布 baseline。无 accept 的失败按[禁止开跑](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md) 映射为 `failed`，退出码 3；JSON 带 `userRecoveryStatus` 与 `reasonCode`。

成功 JSON 至少含 `caseId`、`experimentId`（恢复实验）、`userRecoveryStatus`（`recovered` | `partial` | `failed`）、`canStart`。`partial` 且 `canStart` 为真时，agent 可接着 `run`；是否开跑仍要 `--allow-run`。

### 3.4 `run`

要求已有 `case.json` + `.complete`，且该 Case 已有可运行 baseline（`canStart`）。`--allow-run` 才创建隔离副本并启动 Target Runtime + Controller + Comparison。缺省退出码 5。

`--wait`（agent 默认建议打开）：占 writer.lock 直到 CandidateRun 终态且 Comparison 完成或明确失败。不加 `--wait`：打印 `experimentId` / `runId` 后返回 0，调用方 `status` 轮询。

stdout 在 `--json` 下不混进度。进度与事件摘要写 stderr，或 `--events-jsonl <path>` 旁路文件（避免和信封抢 stdout）。

### 3.5 `report` / `status`

只读，不抢锁。`status`：Case / Experiment / Run 投影字段（state、outcome、fidelity、comparison 是否存在）。`report`：`report.html` 绝对路径、`projection.json` 摘要字段；Comparison 未完成则退出码 6，不编造叙述。

## 4. JSON 信封

子命令加 `--json`，或 stdout 非 TTY 时默认 JSON。人类 TTY 无 `--json` 时打表。**信封经 `Value.Check`。** 字段稳定，不随人类表头改名。

```ts
type CliEnvelope = {
  schemaVersion: 1;
  ok: boolean;
  command: string;
  code: number;           // 与进程退出码相同
  data: unknown;          // 该命令的已校验载荷
  next?: readonly { argv: string; when: string }[];
};
```

`next` 只给合法后续 argv 模板（已填 ID），例如 recover 成功后给出 `reprise run --case … --allow-run --wait --json`。失败时 `ok: false`，`data.error` 为稳定 `kind`（`usage` | `not_found` | `locked` | `confirmation_required` | `recovery_failed` | `preflight_failed` | `comparison_missing`），人类句子在 `data.message`，不把堆栈打到 stdout。

退出码：`0` 成功；`2` 用法/身份无效；`3` 无法恢复且 `canStart=false`；`4` writer.lock；`5` 缺 `--allow-*`；`6` 前置未完成（无 baseline、Comparison 未落盘）；`1` 未分类。

## 5. 给外部 agent 的用法

外部 agent 不解析 TUI，不读产品 JSONL。最小剧本：

```text
reprise sessions list --product codex --json
→ 选用 data.items[].sessionId（必要时 sourcePath）

reprise recover --product codex --session <id> --allow-recovery --json
→ 读 data.canStart；false 则停

reprise run --case <caseId> --allow-run --wait --json
→ 读 data.experimentId

reprise report --experiment <id> --json
→ 打开 data.reportPath，或把摘要字段交给人
```

发布后根 README / `--help` 收录同一段。不在第一版做 MCP：MCP 工具应 1:1 包这些子命令，避免第三套协议。

费用：`--allow-recovery` 与 `--allow-run` 拆开。一次 `--yes` 同时授权两段，作为显式快捷方式允许，help 写明会启动内部模型与候选 Runtime。真实 Target 调用仍遵守现有 opt-in 精神：CLI 的 `--allow-run` 就是这条路径的人/agent 确认，不再另要环境变量；CI 默认仍不调用这些子命令。

## 6. 失败模式

- 只传 `--session` 不传 `--product`：退出 2。
- 列表截断摘要当冻结依据：禁止。`recover` 必须 `inspect`/`import`。
- CLI 在 TUI 已锁定的 Experiment 上 `run`：退出 4，JSON `kind: locked`，含 lock PID。
- 无法恢复仍 `run`：应用层拒绝，退出 3/6，与确认页禁止 Enter 相同。
- `--json` 与人类进度混在 stdout：视为契约破坏。
- 为抢锁杀 TUI 或删除 `writer.lock`：禁止。
- 把 `plan/` 或内部事件类型当作 CLI 稳定面：禁止。稳定面只有信封 + 本节命令标志。

## 7. 代码落点（落地时，非本次）

| 层 | 职责 |
|---|---|
| `src/cli/main.ts` | 无子命令 → TUI；有子命令 → parse、信封、退出码 |
| 新 `src/cli/headless.ts` | 调 `createCodexExperimentWorkflow` / Pack `discover`，不 import `tui/pages` |
| `src/core/schema.ts` | `CliEnvelope` 与各 `data` 载荷 |
| application | 无新编排；最多抽出「从 SessionRef 到已 accept baseline」供 TUI 与 CLI 共用 |
| TUI | 不持有 CLI；History 继续读 `cases/` `experiments/` |

测试：非 TTY 默认 JSON；缺 `--allow-run` 退出 5 且不创建隔离目录；错误 `sessionId` 退出 2；假锁退出 4；`recover` 失败不得 `start`。反向：无子命令仍进 TUI；TTY 无 `--json` 不是合法 JSON 对象也允许（人类表）。

## 8. 待讨论

1. `recover` 是否拆成 `freeze` + `recover` 两个动词（脚本要中间检查 transcript 时有用）。
2. 非 TTY 是否默认 JSON，人类在管道里是否必须 `--table`。
3. `run` 是否第一版就接候选 `--product`/`--model`，或先绑来源 Pack。
4. `--wait` 默认开还是默认立即返回。
5. 是否提供只读 `reprise events --experiment`（JSONL）给要自己做时间线的 agent。
