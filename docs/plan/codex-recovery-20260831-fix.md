# 2026-08-31 走查后的恢复修复规划

状态：A–H 已落地  
范围：同一次 Codex 历史会话走到确认页仍挡住「部分恢复可开跑」的缺口，以及 Recovery **工具面与 Host 调查包**的收敛。不扩大为候选 Runtime、跟随出根 symlink、无界调查预算。  
依据：[TUI](../product/tui.md)、[Environment](../architecture/environment.md)、[校验通过预览自动接受](../decisions/accepted/2026-08-31-recovery-auto-accept-validated-preview.md)、[partial 额外路径](../decisions/accepted/2026-08-30-recovery-partial-extra-paths.md)、[无 accept 不得开跑](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md)、[列表与 Recovery 分界](../decisions/accepted/2026-08-27-session-intake-vs-recovery-agent.md)、[回放起点](../decisions/accepted/2026-08-31-replay-user-task-not-injected-instruction.md)、[证据 catalog](../decisions/accepted/2026-08-17-recovery-evidence-catalog-and-fallback.md)。走查事实在本机 `docs/.local/`（不受控，本文不链过去）。Pi 内置工具面见 [earendil-works/pi](https://github.com/earendil-works/pi) `packages/coding-agent/src/core/tools`（`ToolName`：`read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`）。

上一轮 [N–Q](./codex-recovery-walkthrough-remaining.md) 已落地。本轮两件事要一起设计：走查暴露的校验/预算/TUI 缺口，以及「15 个专用工具」并不比 Pi 的工作区动词更能完成恢复。

## 1. 要变成真的事

同一次真实会话再走到确认页时：

1. **历史用法**：第一轮 context 带 Host **调查包**（路径线索、后续用户约束、已解析 preimage/catalog 摘要）。内容写入事件日志。模型默认用工作区工具对照 staging，不必先翻 transcript。
2. **工具面**：Recovery 只注册下表 8 个工具。工作区对齐 Pi；Host 只留分页读冻结历史。
3. **变更清单 Host 算**：fingerprint 前后差是「改了哪些路径」的唯一来源。Agent 不再靠 `write_recovery_manifest` 申报路径集合。`partial` 只要 Host 看见合法 staging 变更且 tripwire 通过，就能 preview 并自动 accept。
4. **删除/破坏性变更有上限**，只限制破坏本身，不封 `ls`/`read`/`grep`。
5. **时间线**同一诊断合并为 `×N`。
6. **选会话先核对再冻结**。

Done means：`npm run check`；TUI 改动更新 `docs/tui-audit/frames/`；工具面、信封、调查包写 `docs/decisions/accepted/` 并同步 [environment.md](../architecture/environment.md) §7.1；反向用例；不启动真实候选 Runtime。

### 1.1 目标工具面（8 个）

| 名字 | 职责 | 对应 Pi |
|---|---|---|
| `read` | 读 staging 文件（含有界二进制） | `read` |
| `ls` | 列有界目录 | `ls` |
| `grep` | 在 staging 内搜内容 | `grep` |
| `find` | 按名字找路径 | `find` |
| `edit` | 改已有文本文件 | `edit` |
| `write` | 新建或覆写文件 | `write` |
| `powershell` | 唯一 shell：cwd 锁 staging，净化环境，不给凭据，stdout/时限有界（替代 `staging_shell`；不注册 `bash`） | `powershell` |
| `read_observation` | **备胎**：分页读冻结 `transcript` / `historical_events`，带 Host ref | 无（Host） |

**不注册**：`list_dir`、`inspect_workspace`、`read_file`、`write_file`、`write_binary_file`、`rename_file`、`delete_file`、`inspect_git_history`、`staging_shell`、`submit_recovery_plan`、`derive_task_footprint`、`search_recovery_artifacts`、`write_recovery_manifest`、`write_recovery_report`。

删、改名、Git：`powershell` 或 `edit`/`write`。报告：约定 `write` 到 staging 根 `recovery.md`；校验后 Host 摘掉（与今天专用 sink 同一不变量）。契约 JSON 不进候选树。

三个角色工作区动词对齐。Controller / Comparison 的换装、audit、轮间压缩见 [八工具](../decisions/accepted/2026-08-31-internal-agent-eight-tools.md)、[轮间压缩](../decisions/accepted/2026-08-31-internal-agent-turn-compaction.md)、[审计](../decisions/accepted/2026-08-31-internal-agent-audit-and-comparison-requested.md)。`read_observation` 的 source 按角色白名单区分。Recovery prompt：默认先看调查包。

## 2. 非目标

- 跟随出根 symlink、放宽快照、开放凭据、提高无界预算。
- 跳过 Provider 校验或校验失败仍 accept。
- 自动启动计费 Candidate。
- Recovery 解析产品 JSONL 或改 `initialInput`。
- 第一轮塞进全文 transcript（曾经撑爆上下文）。
- Discovery 列表把「窗口里看不到助手」标成硬 `unreadable`。

## 3. 根因

走查：`current_state_fallback`，无 accept。Agent 已 `partial` 并删除 16 个 `.playwright-cli` 文件；校验因信封 `evidenceRefs` 与 manifest 对不齐整单作废。删除上限把 `list_dir` 一并封死。模型几乎没从分页历史里得到「任务产物路径」，调查包本应在 Host 侧就算出来。

```text
需要：历史里和路径/约束有关的事实（可复原）
现在：交给模型用 read_observation 自己翻 162 轮

需要：staging 改了什么
现在：信 Agent 填的 manifest + 信封 refs
Host 其实已经有 fingerprint 差
```

放弃：校验失败仍 accept；让模型把信封 refs 写全；工作区继续维持 15 个专用动词。

## 4. 批次

```text
A 调查包 + 事件     ──► 历史主通道离开「先翻页」
B 工具面 8 个 + ADR ──► 对齐 Pi 工作区；只留 read_observation 备胎
C Host 变更清单     ──► fingerprint 为源；partial 可 preview / 自动 accept
D 破坏性变更上限    ──► 不封读/搜
E 时间线诊断码合并
F 核对页
G Playbook 与 Recovery prompt
H Discovery
```

A 与 C 不依赖新工具名，可先于 B 落地（旧工具仍能跑通走查）。B 必须改 architecture §7.1、Playbook、大量测试。D 在 B 之后按 `powershell`/fingerprint 计，不再按 `delete_file` 次数。

回滚：还原源码、测试、frames、ADR。

| 批次 | ADR |
|---|---|
| A | 必须：调查包是进入模型的 Host 事实，须有事件；体积与字段上限 |
| B | 必须：Recovery 工具面收敛；废弃专用 manifest/report/delete 工具 |
| C | 必须：`partial` 的路径集合以 fingerprint 为准，不要求 Agent 清单与信封 refs 全等 |
| D–H | 否，除非 D 改变「预算耗尽即停调查」的对外语义 |

---

### A — Host 调查包（历史主通道）

**做什么**

在调用 Recovery 模型前，Host 从 TaskCase + `resolvedRecoveryFacts` 生成有界 JSON，例如：

- `initialInput` 已有；另附后续用户句（截断条数/字符）
- 历史中出现的相对路径（来自 events/preimage/`relevantPaths`/catalog），去重、上限（如 256）
- 已验证 preimage / patch 路径摘要（已有 facts，不要再抄全文）
- `isRepo` 等机械事实

整包写入 `recovery.model_input`（或新类型 `recovery.investigation_packet`），字段进 `RecoveryContext`。Prompt：先用包内路径对照 `ls`/`grep`；**仅当包明显不够**（未见的文件名只在某句正文里）才 `read_observation`。

`derive_task_footprint` / `search_recovery_artifacts` 的逻辑并进包的生成函数，不再暴露为工具（可在 B 删除工具时一并下线）。

**验收**

- 夹具会话含 AGENTS + 任务句 + 事件里的 `foo.html`：调查包含 `foo.html` 与任务句，事件可复原该包。
- 反向：包有硬上限；超限截断并标记 `truncated`，不得把全文 transcript 塞进包。
- 走查样本：包内应出现任务相关 html/pptx 名，而不是要求模型先翻 162 轮。

**触及**

`src/application/experiment-recovery-run-model.ts`、`experiment-recovery-support.ts`、`src/agents/recovery-agent.ts`；新测。

---

### B — 工具面改为 8 个

**做什么**

- 工作区工厂对齐 Pi 语义，但路径 containment、禁 symlink、预算与现有 `write_file`/`staging_shell` 同级。Windows 只注册 `powershell`（实现可复用 `staging_shell` 的锁 cwd / 净化 HOME）。
- `read_observation` 保持分页与 catalog ref；默认不再是调查第一步。
- 删除旧工具名；timeline / i18n / Playbook / `environment.md` §7.1 同步。
- `recovery.md`：允许 `write` 该保留名；`validateRecovery` 仍读后 unlink。其它 `write` 不得冒充契约。不要再用 `write_recovery_report`。
- Envelope：`recovered` / `partial` / `insufficient_evidence` + `unresolved`；**不再要求 Agent 调用 manifest 工具**。Host 在校验时从 fingerprint 合成内部 manifest（见 C）。

**验收**

- Recovery 注册工具名集合等于 §1.1；架构测试禁止 recovery 栈再 export 已删工具名。
- 脚本 Agent 只用 `write`+`ls` 改文件、写 `recovery.md`、返回 `partial`，仍能走完校验（配合 C）。
- 反向：`delete_file` 等旧名未注册。

**触及**

`src/infrastructure/recovery-*.ts`、`pi-agent-host.ts`、timeline、两份 SKILL、`docs/architecture/environment.md`、几乎全部 recovery 测试。

---

### C — fingerprint 为变更源（取代 Agent manifest 对齐）

**做什么**

`validateRecovery` / `probeRecovery`：

- `changed = fingerprint 差`（忽略 `.git/`、已摘除的 `recovery.md`）。
- `partial`：不因「信封 refs 不是 manifest 的子集」失败；未知 Agent ref 丢弃。路径以 `changed` 为准。弱证据（仅 Host 观察到删/改）足够 preview。
- `recovered`：每条路径仍要强证据（preimage / git blob 等）。
- `insufficient_evidence`：staging 须与源 capture 一致。
- 成功则自动 `acceptRecovery`（已有决策）。失败则 fallback、无 accept。

走查那种「删了 16 个文件但信封只抄 3 个 ref」必须变成有 preview 的部分恢复。

**验收**

- 夹具：staging 删除若干文件；Agent 信封 refs 不全或为空；`partial` + 非空 unresolved → preview、`acceptedAutomatically`、baseline 在 `baselines/`。
- 反向：无变更且声称 `recovered` → 拒绝。
- 反向：伪造 `event:not-owned-ref` 不得进入 published baseline 的证据表。

**触及**

`local-workspace-fs.ts`、`local-workspace-provider.ts`、envelope 测试。可与 A 同 PR（旧 `write_recovery_manifest` 仍存在时，Host 忽略 Agent 路径集合、只信 fingerprint）。

---

### D — 破坏性变更上限（不封读）

**B 之后**：不再有 `delete_file` 计数。上限改为 Host 统计本轮 fingerprint 中 `removed` 条数，或 `powershell` 成功删除次数，例如 16。达到后拒绝继续删除类操作；`ls`/`read`/`grep`/`find`/`read_observation`/`edit`/`write`（非删）仍可用。

**B 之前的过渡**（若 C 先合）：旧 `chargeRecoveryToolBudget` 仅当 `name==="delete_file"` 且满 16 时失败，**不** `onBudgetExhausted`，不挡 `list_dir`。改掉「list_dir 必须失败」的测试。

**验收**

- 满上限后读/列目录成功；再删失败。
- 反向：第 16 次删除仍成功；调查总次数耗尽时非读工具仍失败。

---

### E — 时间线按诊断码合并

合并键用稳定诊断（删除上限、调查预算耗尽），不含路径。Git 非仓库：`powershell` 的 git 输出或 Host 调查包里的 `isRepo=false` 仍须可见（包内一句即可，不必保留 `inspect_git_history` 工具）。

**验收**：多条仅路径不同的上限失败 → 一行 `×N`。反向：上限句与预算耗尽句不合并。

---

### F — 选会话先 inspection

会话 Enter → 核对页（任务起点句）；核对 Enter → `freeze` + 恢复。`chooseSession` 文案与行为一致。不可回放进错误页。

**验收**：intake 测试 + `docs/product/tui.md` + `tui-audit/frames`。反向：无用户输入不得出现可冻结核对卡。

---

### G — Playbook 与 prompt

- 先读调查包，再用 `ls`/`grep`/`find` 对照 staging。
- `.playwright-cli`、构建缓存不是默认删除对象。
- 禁止解析产品 JSONL、禁止跟随出根大树。
- `read_observation` 仅当包内没有决策所需的那句原文。
- `recovery.md` 写不确定项；不要编造路径清单。

**验收**：SKILL hash 测试；prompt 快照。

---

### H — Discovery

- 顶栏空心灯只表示未选会话产品：home 无冻结任务时仍空心。产品列表光标所在 Pack、以及已进入该 Pack 的项目/会话页，顶栏实心灯（与 CLI 登录、Harness 密钥无关）。
- 打开 `/intake` 时光标落在上次浏览的 Pack，否则第一项；顶栏跟随光标。
- 发现说明分行：指令、已加载计数、分页、catalog 全局诊断各占一行。`catalog-unavailable` / `invalid-jsonl` 标明不是当前行损坏。
- 列表残缺摘要（`partial` 或 `catalog-only`）只展示已计数的 `uN`，不写未扫描的 `a0 t0`。核对页仍用 inspect 后的完整信号。

## 5. 确认页

| 条件 | 用户终态 | 开跑 |
|---|---|---|
| fingerprint 有合法变更且校验通过 | 部分恢复或已恢复；限制含 unresolved / 跳过的 symlink | 允许 |
| 无合法 staging / tripwire 失败 | 无法恢复 | 禁止 |

走查中已删路径应出现在限制或变更摘要里，不得在校验失败时假装已恢复。

## 6. 实施顺序

1. **A + C**（调查包 + fingerprint 为源）——旧工具仍可用，走查类夹具应能自动 accept。
2. **D 过渡**（删除上限不误伤 list）若 C 单独合入。
3. **B + D 最终 + G**（换 8 工具、预算改计、文档）。
4. **E、F**（TUI）。
5. **H**（Discovery 顶栏/页脚/信号）。

复跑同一 jsonl、同一源目录、停确认页。通过：调查包事件存在；`hasAccept` 或 `baselines/` 有 root；确认页部分恢复；核对页能打开。
