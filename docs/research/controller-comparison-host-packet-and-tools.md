# Controller / Comparison：工具面与 Host 调查包审查

本文是讨论稿，不是实施计划，不覆盖 [`architecture/`](../architecture/overview.md)。前提已定：**Controller 与 Comparison 具备 Pi 的基本工作区能力**，与 [Recovery 规划](../plan/codex-recovery-20260831-fix.md) 同一套动词；本文只回答「 besides 这套，还要不要 Host 专用工具」。克制标准：**工作区里已经是文件的，不再为它注册第二种读法。**

Windows 不注册 `bash`，只注册 `powershell`。Pi 全表见 [earendil-works/pi](https://github.com/earendil-works/pi) `ToolName`。落地时 [controller-experiment-conditions.md](../architecture/controller-experiment-conditions.md) §4「第一版不提供 shell」必须改掉并写 ADR；旧规范不能否决这套工具面。

不讨论 prompt 润色（[prompt 重设计](../plan/agent-system-prompt-redesign.md) 里「没有 Recovery」已过时）。

## 1. 底盘（不再讨论要不要）

三个内部 Agent **都注册**工作区七件套（再加同一个 `read_observation`，共八个）。不按角色裁掉 `edit` / `write` / `powershell`。

| 名字 | 职责 |
|---|---|
| `read` | 读文件（含有界二进制） |
| `ls` | 列目录 |
| `grep` | 搜内容 |
| `find` | 按名字找路径 |
| `edit` | 改已有文本 |
| `write` | 新建或覆写 |
| `powershell` | 唯一 shell：锁 cwd、净化环境、不给凭据、stdout/时限有界 |

Containment 与 Recovery 同级：禁出根、禁凭据、有界输出。写操作进 journal / 事件，不靠 prompt 当安全机制。

**cwd 不是同一棵树：**

| 角色 | 工作区根 | 写的含义 |
|---|---|---|
| Recovery | staging | 恢复任务树 |
| Controller | 当前候选隔离副本 | 用户在自己项目里本来就能看、改、跑命令；不调用 Target Runtime，不写源目录 |
| Comparison | 见 §3 的报告沙箱 | 读副本与证据文件；`write` 只应落到 Host 规定的报告路径 |

Controller 的 `message` 仍是发给候选的唯一用户输入；工作区工具不能代替 `send`。Comparison 不改 CandidateRun 状态机。

## 2. 还要不要别的工具

判决句：若 Host 把该事实 **物化成工作区文件**，就不要专用工具；若它只存在于 store / 分页 API、且不宜整包落盘，才留一个 Host 工具。

今天代码里多出来的三个（[`agent-tools.ts`](../../src/infrastructure/agent-tools.ts)）逐个对照：

| 现有专用工具 | 工作区能否替代 | 结论 |
|---|---|---|
| `read_artifact` | catalog 物化到沙箱 `evidence/` 后，用 `read`/`ls` | **删**。不要「按 artifactId 读」和「按路径读」两套 |
| `write_comparison_report` | 约定 `write` 到沙箱根 `report.html`（校验后 Host 拷到实验根，与 Recovery 的 `recovery.md` 同一套路） | **删** |
| `read_observation` | transcript / `run_events` **不是** 候选树里的文件 | **默认留一个**，除非走 §2.1 把历史也落成文件 |

不要加回 Recovery 那些调查专用词：`inspect_workspace`、`inspect_git_history`、`derive_task_footprint`、`search_recovery_artifacts`、`submit_recovery_plan`、manifest/report 契约工具。`grep`/`find`/`ls` 已经覆盖「在树里找」。

不要把 `read_observation` 拆成 `read_transcript` + `read_run_events`：多一个名字、同一分页机制，不克制。source 参数留下即可。

### 2.1 零 Host 工具的条件（更克制，可后做）

Host 在沙箱里写入有界文件，例如 `history/transcript.jsonl`、`history/run-events.jsonl`（截断 + `truncated` 标记），并记一条事件（digest）。则三个角色都可以 **只注册七件套**。代价：落盘格式、截断与 privacy 红线、以及「进入模型的输入可复原」要绑这些文件而不是分页 API。

未做这段之前，**唯一额外工具是 `read_observation`。**

### 2.2 不要用专用工具补的事

- 后续用户句、`changedPaths`、`reportFacts`：继续放进 briefing / `SteeringContext`（Host 调查包），不要 `derive_*`。
- 信封 `evidenceRefs`：假 ref 拒绝、空数组允许；路径真相仍是 fingerprint，不要求模型列全。
- 第一轮不要塞全文 transcript。
- Comparison 的 HTML 仍由模型写完整文档，Host 不拼模板。

## 3. 各角色目标工具面

**Controller：同一 8 个**

- 八工具 cwd = 隔离副本。判断「够不够好 / 要不要 verify」用 `ls`/`read`/`grep`，必要时 `powershell`；发给候选的唯一用户输入仍是 `send` 的 `message`。
- `read_observation`：只在需要原文时翻冻结会话或本 run 事件（用户先验 vs 历史 Agent 发现；核对候选问句是否已在历史里回答过）。
- 第一轮仍带现有 snapshot；包保持薄，正文靠工作区读。可选：摘要里加「最近可见问句」，仍不是新工具。

**Comparison：同一 8 个**

报告沙箱建议一棵树，避免第三种读工具：

```text
comparison-sandbox/
  candidate/     # 现有隔离副本的只读挂载（路径映射 + 拒写，不拷贝、不建 junction）
  evidence/      # host-trace.json、workspace-scope.json 等 catalog 物化
  report.html    # 唯一约定交付文件
```

`powershell` 的 cwd 锁在这棵沙箱。`write`/`edit` 以及对 `candidate/` 会改盘的 `powershell` 一律拒绝；只允许写 `report.html`（以及 Host 明确列出的草稿名，能不列就不列）。这是 **策略约束同一套工具**，不是再注册 `write_comparison_report`。挂载语义见 [模块设计审查 §6.1](./three-agents-design-review.md)。

briefing JSON 继续当调查包。缺的工程对称：`comparison.requested` digest、audit 进 store——不是新工具。

**Recovery：** 同一 8 个；cwd = staging。规划见 [2026-08-31](../plan/codex-recovery-20260831-fix.md)。三个角色工具名对齐，cwd 与写策略不同。轮间压缩见 [模块设计审查 §6.2](./three-agents-design-review.md)。

## 4. 现状（只作对照）

- Controller 实际只注册了 `read_observation`，看不到副本正文。
- Comparison 实际是 `read_artifact` + `read_observation` + `write_comparison_report`，没有工作区动词。
- Comparison 的 briefing 可从 store 重建，但工具页未进 ExperimentStore。

## 5. 落地时必改的规范（提醒，不是本文拍板）

工作区工具一旦注册，这些句子要改或写 ADR，否则代码与文档打架：

- Controller 工具「必须只读、不提供 shell」
- Comparison「只有只读 artifact 与 telemetry」
- validation：内部 Agent 不得写环境——需改成「不得写源目录 / 不得改 RunOutcome；隔离副本与报告沙箱按角色策略」

## 6. 和 Recovery 的共用

- 共用工作区工厂与 `read_observation` 实现，source 白名单按角色传入。
- fingerprint / `changedPaths` 仍只信 Host。
- `report.html` 与 `recovery.md` 都走保留名 + 校验后摘到 Host 拥有位置；不要两个角色两种契约工具。

## 7. 还开放的只剩实现选择

当前规范见 [八工具与写策略](../decisions/accepted/2026-08-31-internal-agent-eight-tools.md)。审查稿里可后做的：§2.1 物化历史以去掉 `read_observation`。
