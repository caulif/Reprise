# A–H 落地后仍挡住部分恢复的缺口

状态：已落地  
范围：同一次 Codex 历史会话走到确认页时，Host 仍因 **staging 任务路径变更为 0** 拒绝 preview。不扩大为候选 Runtime、跟随出根 symlink、无界调查预算、跳过 Provider 校验。  
依据：[Environment §7.1](../architecture/environment.md#71-内部工作空间与实际边界)、[八工具](../decisions/accepted/2026-08-31-recovery-pi-aligned-tools.md)、[fingerprint 为变更源](../decisions/accepted/2026-08-31-recovery-fingerprint-changeset.md)、[校验通过则自动接受](../decisions/accepted/2026-08-31-recovery-auto-accept-validated-preview.md)、[无 accept 不得开跑](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md)、[回放起点](../decisions/accepted/2026-08-31-replay-user-task-not-injected-instruction.md)、[Windows shell 与点路径](../decisions/accepted/2026-08-31-recovery-windows-shell-and-dot-paths.md)、[上一轮 A–H](./codex-recovery-20260831-fix.md)。走查事实在本机 `docs/.local/`（不受控，本文不链过去）。

上一轮 A–H 已把调查包、八工具、fingerprint 源、核对页、Discovery 顶栏/页脚做成真的。确认页仍是「无法恢复」，根因从「信封 refs 对不齐」变成「shell 起不来 → 没有变更 → Verifier `no_task_path_outcome`」。Fingerprint 拒绝空变更是对的，不要为绿灯放宽校验。

## 1. 要变成真的事

同一次真实会话再走到确认页时：

1. **`powershell` 能在 Windows staging 里跑起来。** 删除/改名走 shell 时，失败必须带可操作类别（找不到可执行文件 / 超时 / 非零退出），不能八次都是不带 errno 的 `spawn error`。
2. **工作区动词接受「当前目录」。** `ls` / `grep` / `find` 把省略路径、`""`、`.`、`./` 当作 staging 根；继续拒绝 `..`、绝对路径、反斜杠。
3. **模型先用调查包里的相对路径。** Playbook / Recovery prompt 写明：列根用省略 `path` 或 `.`；不要把 Windows 盘符路径塞进 `ls`。
4. **有合法 staging 变更时确认页是部分恢复。** fingerprint 非空且 tripwire 通过 → preview + 自动 accept → Enter 可开跑。变更为 0 仍禁止开跑。
5. **核对页后续用户轮次不再展示注入块残句。** 起点句已经按启发式取任务句；后续列表用同一启发式过滤或降级标注。
6. **进入项目列表时光标有可解释的默认。** 优先当前工作区对应的项目；否则记住上次打开的项目；再否则才是「最近活动第一项」（可能是无关的 WSL 目录）。

Done means：`npm run check`；触及 TUI 则更新 `docs/tui-audit/frames/`；shell/路径改动带反向用例（找不到 pwsh 时失败可诊断；`..` 仍拒绝）；不启动真实候选 Runtime。

## 2. 非目标

- 跟随出根 symlink、放宽快照、把凭据放进 shell 环境。
- 校验失败或 `changedPaths.length === 0` 仍 accept。
- 自动启动计费 Candidate。
- 改冻结 `initialInput` 契约。
- 把 `ls` 改成接受任意绝对路径或 `..`。
- 为了少一次 spawn 失败去注册 `delete_file`。

## 3. 现在具体有哪些问题

按「挡住开跑」到「体验噪音」排序。前两项不修，A–H 的 fingerprint / 自动 accept 在这条真实会话上不会被走到。

### 3.1 `powershell` 全部 spawn 失败（挡住开跑）

走查：8 次 `powershell`，8 次 `Process boundary failed: powershell (spawn error)`。随后 `recovery_no_information_gain`。`write` 两次成功（报告通道），Host 校验时 **任务路径变更仍为 0**。

代码：[`recovery-workspace-tools.ts`](../../src/infrastructure/recovery-workspace-tools.ts) 在 Windows 上把可执行文件写死为 `C:\Program Files\PowerShell\7\pwsh.exe`，cwd 锁 staging，环境是白名单净化后的副本。[`process-runner.ts`](../../src/infrastructure/process-runner.ts) 把 `child.on('error')` 一律标成 `spawn_error`。工具返回给模型的字符串**不含** `errnoCode`（`ENOENT` / `EINVAL` 等），事件 payload 也只有那句英文。

后果：没有 shell 就删不了历史 `.playwright-cli` 一类产物；fingerprint 为空；Verifier [`no_task_path_outcome`](../../src/application/recovery-verifier.ts) 拒绝 `partial`；确认页无法恢复、Enter 受阻。这与「不要跳过校验」一致，但操作者看到的是校验码，不是「PowerShell 7 没装上 / 进程起不来」。

可能原因（实现时用反向用例钉死，不要猜着改）：

- 本机没有 PowerShell 7，绝对路径 `ENOENT`。
- 净化环境缺 `SystemRoot` / `WINDIR` 时，Windows `CreateProcess` 失败。
- staging cwd 过长或含特殊字符导致 spawn `EINVAL`（次要，走查路径长度通常低于 MAX_PATH）。

### 3.2 `ls` / `grep` 把「当前目录」当成非法路径（浪费预算）

`ls` 省略 `path` 时已经列 staging 根。模型按 Pi 习惯传入 `.` 或 `./` 时，[`pathIn`](../../src/infrastructure/recovery-workspace-tools.ts) 把每一段 `"."` / `".."` 都拒绝，文案是 `Path must be a non-empty slash-separated relative path without . or ...`。走查：`ls` 12 次里 9 次失败；`grep` 1 次失败。时间线已把同一句收成 `×3`，但调查预算仍被烧在可规范化的参数上。

`..` 和绝对路径、反斜杠必须继续拒绝（已有测试）。缺的是 **`.` ≡ 根**。

### 3.3 Playbook 没把调查包用成主通道

Host 已写 `recovery.investigation_packet`（走查 `pathCount=170`，`truncated=true`，后续用户句 4）。模型仍大量 `find`（23）和失败的 `ls`/`powershell`。提示词没有把「列根不要传盘符、`.` 可以、删除用相对 posix 路径」写成硬约束。这不替代 3.1/3.2，只减少空转。

### 3.4 核对页后续轮次露出注入块

会话 Enter 已打开核对页；冻结起点是任务句（走查 252 字 PPT 需求）。后续用户列表用「除起点外的全部 user」，`sessionTitle` 只做截断。走查 2/6 仍是 skill / AGENTS 残句（「don't re-write it」）。冻结契约不变；这是展示层。

### 3.5 项目列表默认光标落在最近活动，而不是当前工作区

产品层 H 已记住上次 Pack。进入 Codex 项目页后 `selected = 0`，排序是各项目最新会话时间。走查第一项是无关的 `.hermes`（WSL），目标项目在第一屏中部，只能搜索。这不挡恢复正确性，但每次真实走查都要依赖搜索字符串。

### 3.6 确认页诊断仍偏机器码

无 preview 时文案已是「无法恢复」+「工作区校验未通过（provider_validation_failed）」。根因其实是 **shell 没跑起来 / 没有变更**。`reasonCode` 停在校验层，没有把 `spawn_error` / `ENOENT` 提升成操作者能对照的一句。修 3.1 后，至少工具时间线要能看出「找不到 pwsh」；确认页可附带「没有观察到工作区变更」。

### 3.7 不在本轮必做

- 轮间压缩次数多（走查 41 次 `agent.context_compacted`）：有八工具决策约束，不在本缺口里改策略。
- catalog 全局 `invalid-jsonl`：页脚已标明不是当前行。
- 出根 `ppt_build/node_modules` symlink：非目标，继续跳过。

## 4. 各部分如何修

### A — Windows `powershell` 可启动、失败可诊断

**改什么**

- 解析可执行文件：存在则用配置/探测到的 pwsh 7；否则 `SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`；再否则工具失败，文案含 `ENOENT` 与「未找到 PowerShell」。
- `sanitizedEnvironment` 必须带上 Windows 进程启动所需的 `SystemRoot`、`WINDIR`、`ComSpec`（已在白名单则断言复制成功；缺则从 `process.env` 按大小写不敏感补）。
- `ProcessBoundaryError.errnoCode` 进入工具 `details` 和返回给模型的短句。事件仍不写 cwd/命令原文。
- 不把整个 `process.env` 灌进 child。

**不要做**：为了 spawn 成功而 `shell: true` 拼命令；不把 API 密钥放进 child env。

**验收**

- 单元：注入不存在的 executable → 失败含 `ENOENT`；`..` 命令仍被路径/策略挡住。
- 反向：故意缺少 pwsh 路径时门禁或测试失败（工具必须报告找不到可执行文件，而不是空 `spawn error`）。
- 有 pwsh 或 Windows PowerShell 的机器上，`Remove-Item` 相对路径能改变 fingerprint（已有工具测可扩一条真实 spawn，默认路径继续 mock）。

### B — 工作区路径：`.` 是根，`..` 仍非法

**改什么**

- `pathIn` 之前规范化：`undefined` / `""` / `.` / `./` → 列/搜 staging 根（与今天省略 `ls.path` 同一分支）。
- `..`、空段、绝对路径、`\` 继续抛现有错误。
- `grep` / `find` / `read` / `edit` / `write` 共用同一规范化；`read` 的路径仍不能是根本身（根不是文件）。

**验收**

- `ls({ path: "." })` 与省略 path 的目录列表一致。
- `ls({ path: ".." })`、`ls({ path: "C:/x" })` 仍失败。
- 反向：若有人把 `.` 重新当非法，测试红。

### C — Playbook / Recovery prompt

**改什么**

- 明确：调查包里的路径已经是相对 posix；先 `ls` 根或 `read` 包内路径。
- 删除用 `powershell` + 相对路径（`Remove-Item -LiteralPath '.playwright-cli\\...'` 是否允许反斜杠：shell 命令是字符串，**不走** `pathIn`；Playbook 写「cwd 已是 staging，不要 cd 到盘符」）。
- 禁止为「列当前目录」传盘符绝对路径。

**验收**：prompt / SKILL 快照。不靠模型一次走查当门禁。

### D — 核对页后续 user 过滤注入块

**改什么**

- [`renderInspection`](../../src/tui/pages/intake.ts) 的后续列表：对每条 user 跑已有 `looksLikeInjectedInstruction`；像注入块的不进「后续用户轮次」，或单独标「指令块（不作为回放起点）」。
- 计数 `n/m` 以过滤后的任务句为准，避免 2/6 指向 skill 残句。
- **不改** `firstReplayUserMessage` / `initialInput`。

**验收**：现有「instruction 开头 + 后续短任务」fixture 上，核对页正文不含 `don't re-write it` 一类条款句；TUI 帧 `11b-inspection-review` 若文案变则重生。

### E — 项目列表默认光标

**改什么**

- 进入 `projects` 时：若 `displayCwd`（或 intake 工作区）被某个项目 `path` 包含，选中该项。
- 否则若有 `lastProjectKey`（与 `lastProductId` 同级），选中它。
- 否则保持「最近活动」第一项。
- 不把「名字像 Codex」的项目当默认。

**验收**：夹具里两个项目、cwd 落在第二个时，打开产品后光标在第二个。反向：cwd 不匹配任何项目时仍是最近活动第一项。

### F — 确认页：无变更与校验失败分开说

**改什么**

- `changedPaths.length === 0` 且 Agent 报 `partial` 时，操作者诊断优先「没有观察到隔离工作区变更」（可并列 `no_task_path_outcome`），不要只重复 `provider_validation_failed`。
- 有变更但 tripwire/校验失败，才强调工作区校验未通过。
- 不把 spawn 失败伪装成已恢复。

**验收**：无变更 fixture 确认页中文含「没有…变更」；有变更校验失败仍是无法恢复、Enter 受阻。

## 5. 实施顺序

```text
A powershell 可启动     ──► 没有 shell 就没有 fingerprint 差
B `.` 当作根            ──► 调查工具不再空转
C prompt 对齐调查包     ──► 少烧预算（可与 B 同 PR）
F 无变更文案            ──► 确认页诚实（可后于 A）
D 核对页过滤注入块      ──► 不挡开跑
E 项目默认光标          ──► 不挡开跑
```

A 未绿之前不要指望同一次真实会话自动 accept。B/C 降低噪音。D/E 是 Discovery 剩余体验。

回滚：还原 `recovery-workspace-tools.ts`、`process-runner` 调用方、prompt 快照、TUI 帧。

## 6. 复跑同一会话时怎样算过

停在确认页，不启动候选：

- 时间线出现成功的 `powershell` 或等价工作区变更，而不是 8 次 spawn error。
- `events.jsonl` 仍有 `recovery.investigation_packet`。
- 若 fingerprint 出现合法删除/修改且 tripwire 过：`hasAccept=true`，确认页部分恢复，Enter 可开跑。
- 若模型选择不改工作区：确认页仍无法恢复，文案指向无变更，不是「shell 起不来却假装校验过」。
- 核对页后续轮次看不到 AGENTS 条款残句。
