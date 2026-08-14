# Reprise 第六轮优化分析

> 日期：2026-08-13　范围：`src/`、`test/`、`scripts/`、CI、打包、文档组织
> 方法：四个并行深度审查（应用核心层、基础设施/协议层、TUI 层、工程卫生），关键结论均对照当前源码逐行核实，P0 级结论另做了动态复现或行为验证。
> 定位：时点审查，指导改动，不定义规范。只列前几轮未覆盖、或前几轮声称已修但核实为未完成/引入回归的条目。
>
> 与第五轮优化分析的关系（那份文档已执行完毕并移入本地保留区，不再受版本控制）：它由并行工作产出，本轮独立完成后交叉核对。其 P0（`npm run check` typecheck 失败）**在本轮验证时已不复现**（`npm run typecheck` 退出码 0）；其 P1-1（报告打开假成功）、P1-2（预算阻断太晚）本轮独立复核属实，已并入下文。两份文档其余条目互补，不冲突。

---

## 0. 本轮核实过的基线事实

| 项目 | 现状 |
|------|------|
| `npm run typecheck` | 通过（round-5 文档记录的失败已修复） |
| 测试 | 125/125 通过（TUI 审查中实测） |
| 第四轮修复 | 声称的约 30 项逐条核验，绝大多数属实且有测试背书；**3 项未完成**：`controller-agent.ts:58-62` 的 rejected session Promise 仍永久留在 Map、`runtime-port.ts` 的 `child.stdin` 未 destroy、command overlay「复用」只是 query 不变时跳过重建（每次击键仍是完整 hide + new SelectList 生命周期） |
| `/config` 方案 B | 全部落地：caret 画 raw buffer、预填当前值、env set/missing 状态条、Home 指路改 shell、provider 切换二次确认、密钥粘贴拒绝、文本页不抢字母键 |
| `@earendil-works/*` 0.84.1 | 就是 npm 最新版，并不陈旧 |
| `dist/` | 确被 `.gitignore` 忽略（`git check-ignore` 证实） |

**但第四轮的一项 P0 修复本身引入了本轮最严重的回归（见 P0-1）**，且两个 P0 级证据缺陷（P0-2、P0-3）恰好都落在「mock 输入 + 静态帧审计 + 恒真测试」测不到的盲区——与 `tui-config-editor.md` §4 复盘的漏检机制完全同构。

---

## 1. 结论摘要

1. **TUI 主路径当前必然启动失败**：baseline marker 被算进指纹，preflight 指纹与执行时指纹永不相等，只要 preflight 成功过，每次启动实验都抛 "source changed after preflight"。这是第四轮 P0-4 修复叠加新管线造成的回归，测试因恒真而失守。
2. **两处证据链在说谎**：客户端合成事件被双重加前缀导致 `rejectedApprovals` 恒为 0（目标申请审批被拒这一关键事实从 Controller 观察与报告中消失）；`allowModelText: false` 可被观察工具整体绕过。
3. **真实终端里所有文本框无法粘贴**：bracketed paste 包裹标记未解包，粘贴被静默丢弃。/run 的绝对路径、/config 的 `env:NAME`、intake 的中文搜索全部只能手打。
4. 工程侧最紧急的是**隐私**：12.2 MB 真实 Codex 会话原始数据（含个人项目名）躺在 `docs/tui-live-run/data/` 待提交，一旦 `git add docs/` 即永久进入历史。

按投入产出，先做四件事：P0-1（约 5 行 + 两条测试）、P0-2（约 10 行 + 一条测试）、P0-3（约 15 行 + 一条测试）、给 `docs/tui-live-run/data` 补 ignore（1 行）。

---

## 2. P0：主路径失败、错误证据、用户级阻断

### P0-1　baseline 指纹包含 harness 自己写入的 marker，`expectedSourceFingerprint` 校验必然失败

**位置**：`src/environment/local-workspace-provider.ts:121,129,138` + `src/application/codex-experiment.ts:114-116` + `src/tui/controller.ts:707`

```ts
// resolveBaseline：marker 写进 baselineRoot 内部，之后对整棵树重新指纹
const markerPath = join(baselineRoot, '.reprise-baseline.json');
// ...
await writeFile(markerPath, JSON.stringify({ sourceFingerprint: inspected.fingerprint.digest }), { flag: 'wx' });
// ...
const fingerprint = await fingerprintTree(baselineRoot);
return { ...inspected, fingerprint, root: baselineRoot };
```

preflight 的 `sourceFingerprint` 来自 `inspectBaseline`（对**源目录**指纹，无 marker）；`resolveBaseline` 返回的是对 **baseline 副本**重算的指纹，其中含 `.reprise-baseline.json`。两个 digest 永远不等，而 `controller.ts:707` 无条件把 preflight 指纹传给 start——**只要 preflight 成功过，每一次实验启动都抛 "The selected source changed after preflight"，即使源目录一个字节没动**（已动态复现：inspect 与 resolve 的 digest 确认不同）。

**连带后果（同一根因）**：`prepareRun` 的 `copyTree(baselineRoot, runRoot)` 把 marker 一起复制进候选工作区——目标 agent 能看到一个原始会话中不存在的文件，污染重放保真度；`candidate-workspace-scope.json` 里的 `baselineFingerprint` 也与 preflight 报告的 `sourceFingerprint` 对不上，证据自相矛盾。

**为什么四轮 review 加实测都没发现**：`test/codex-experiment.test.ts:153-163` 只测「源变了会被拒绝」——由于指纹永远不匹配，这条测试**恒真**；`test/environment.test.ts:76-78` 比的是两次 `resolveBaseline`（都含 marker，自然相等），从未交叉比较 inspect 与 resolve；唯一一次真实 TUI 运行在凭据校验就失败，从未走到这行。

**修复方向**：marker 移出 baseline 树（如 `baselines/<caseId>.marker.json` 兄弟文件），或在 `fingerprintTree`/`copyTree` 中排除该文件名。补两条测试：`inspectBaseline().digest === resolveBaseline().digest`；「源未变 + expectedSourceFingerprint → 启动成功」的正向用例。

### P0-2　客户端合成事件双重前缀，`rejectedApprovals` 恒为 0

**位置**：`src/products/codex/runtime-port.ts:241-243`（`#emit` 已带 `codex.` 前缀）+ `:370-371`（`#onNotification` 对所有 method 再加一层）

```ts
async #onNotification(method: string, params: unknown): Promise<void> {
  await this.#sink.append(event(`codex.${method.replaceAll('/', '_')}`, params));
```

`#emit('codex.stderr', ...)` 等伪通知经此入口落进 journal 时变成 `codex.codex.stderr`、`codex.codex.server_request_rejected`。三个消费方因此出错：

1. `codex-experiment.ts:352` 匹配 `codex.server_request_rejected` **永不命中**——`RunInspection.rejectedApprovals` 恒为 0。目标试图申请审批被拒绝这一关键事实，在 Controller 决策依据和最终报告里完全消失。这是 Harness 核心产出被污染。
2. `timeline.ts:71` 只覆盖 runner 直发的 `codex.protocol_error`；客户端 JSONL 解析错误（`codex.codex.protocol_error`）在 timeline 不可见。
3. `timeline.ts:73` 已**将错就错**写死 `case 'codex.codex.stderr'`——双前缀已进入生产数据并被固化，说明此 bug 存在已久且被绕过而非修复。

**修复方向**：`#emit` 传裸名（`'stderr'`、`'server_request_rejected'`…），由 runner 统一加前缀；`timeline.ts:73` 改回 `codex.stderr`；补一条「fake app-server 发 server request → rejectedApprovals 计数」的端到端测试。历史 journal 若需兼容，消费侧可同时匹配两个名字一个版本周期。

### P0-3　真实终端里所有文本输入无法粘贴（bracketed paste 未解包）

**位置**：`src/tui/format.ts:20-22`（判定函数）；受害分支 `controller.ts:200`（Home composer）、`:349`（intake 搜索）、`:605`（source root）、`config-input.ts:90`（config 编辑器）

```ts
export function isTextInput(value: string): boolean {
  return /^[^\u0000-\u001f\u007f]+$/.test(value);
}
```

生产路径 `TuiAltScreen(new ProcessTerminal())` 会开启 bracketed paste（已读 pi-tui 包源码确认），粘贴内容以 `\x1b[200~<内容>\x1b[201~` **整段**送入监听器。上面的正则遇到首字符 `\x1b`（控制字符）直接不匹配——**粘贴被静默丢弃，界面零反馈**。/run 要输入 `C:\Users\...` 绝对路径、/config 要输入 `env:OPENAI_API_KEY`、intake 要搜中文项目名，恰恰是 Windows 用户最依赖粘贴的三处。全部现有测试用 `handleInput('C:\\explicit-source')` 裸串喂入，永远遇不到包裹标记——正是 `tui-config-editor.md` §4.5 预言的「mock TUI 测不出粘贴」。

**修复方向**：`handleInput` 入口先解包——匹配 `/^\x1b\[200~([\s\S]*)\x1b\[201~$/` 则取内部文本（剥掉控制字符）按文本输入分发；补一条带包裹标记的粘贴测试。约 15 行。

---

## 3. P1：资源、崩溃归因、隐私与核心体验

### 3.1 协议与存储

| # | 位置 | 问题 | 修复方向 |
|---|------|------|----------|
| 1 | `runtime-port.ts:267-273` | **`CodexTargetRunner` 没接 `onClosed`**（`text-caller.ts:82` 传了，runner 没传）。目标进程 mid-turn 崩溃时 `#waiter` 无人 reject，只能等满 turn 超时（分钟级白烧预算），`candidate-run.ts:157` 把它归因为 `limit.turn_timeout`，而 child exit 不产生任何 journal 事件——**崩溃事实在证据链里完全缺失**。第四轮的「进程崩溃即时失败」只修了 TextCaller 一半 | 补 `onClosed`：置 `#status='stopped'`、fail settlement、append `codex.process_exited`；fake app-server 加 `process.exit(1)` 测试 |
| 2 | `runtime-port.ts:117-124` | Windows 下 `.cmd` shim 走 `shell: true`，Node 拼接命令行**不加引号**。npm 全局 shim 典型位置 `C:\Users\<用户名>\AppData\Roaming\npm\codex.cmd`——用户名带空格（Windows 极常见）时启动直接失败。这是 Windows-first 项目的主发现路径 | shell 分支下传 `"${executable}"`（1 行） |
| 3 | `experiment-store.ts:423-425`（`open()` 调用链） | **未持有 writer.lock 就 `truncate` 修复 journal 尾部**。第二个进程 `open()` 同一实验目录时，若赶上活跃 writer 一次大 payload 未写完，会把半行截断，writer 剩余字节接在截断点后拼接错乱——下次 open 抛 checksum mismatch，**整个 journal 永久不可读**。修复代码把损坏窗口从「崩溃后」扩大到了「并发打开时」 | 尾部修复移入 `acquireWriter()`（持锁后执行）；`open()` 阶段只在内存里忽略不完整尾行 |

### 3.2 应用与证据

| # | 位置 | 问题 | 修复方向 |
|---|------|------|----------|
| 4 | `agent-tools.ts:13-22` | **`allowModelText: false` 可被观察工具整体绕过**。应用层认真地按开关隐藏 `finalMessage`（`codex-experiment.ts:375,381`）和报告叙事，但 Controller/Comparison 的 `read_observation` 无任何门控：`source='transcript'` 直接返回含 assistant 全文的原始 transcript，`source='run_events'` 返回的 `codex.item_completed` payload 就是被门控的全文 | `observationTools` 增加 `allowModelText` 参数，为 false 时对 assistant 消息与 `text` 字段脱敏；补测试 |
| 5 | `local-workspace-provider.ts:123-137` | **baseline 捕获中断后目录永久卡死**。`copyTree` 中途崩溃留下「有部分文件、无 marker」的目录；重试时 `created=false` 不清理，再次 copy 立刻 `EEXIST`，每次重试都抛裸错误、无任何「删除该目录重建」指引。freeze 已做两阶段提交（第四轮 §3-8），同构问题被遗漏 | 与 freeze 一致：先写 `<baselineRoot>.tmp` 再 rename；或检测「目录在但无 marker」视为残骸删除重建 |
| 6 | `open-report.ts:10-13` | **打开报告假成功**：`queueMicrotask(resolveOpen)` 在 spawn 的 `error` 事件（下一个事件循环）之前必然先 resolve，启动失败用户看到的仍是成功提示（round-5 P1-1，本轮独立核实属实） | 等待可观测的 spawn 结果，或文案改「已请求系统打开」；注入 spawn 工厂覆盖成功/失败两条路径 |

### 3.3 TUI 核心体验

| # | 位置 | 问题 | 修复方向 |
|---|------|------|----------|
| 7 | `workbench.ts:79-88` + `pages/intake.ts:183-233`、`pages/history.ts:16-28` | **长列表选中项滚出视口且键盘无法滚回**。sessions/projects/history 三个列表全量渲染、无窗口化，layout 模式包在 `follow: 'end'`（钉底）的 ScrollView 里：光标初始在第 0 行、视口钉底，**用户在移动一个看不见的选择**。keyboard-only 的 TUI 没有任何滚动键。全部测试断言走字符串渲染路径，layout 路径零覆盖 | 复用 running timeline 的 `windowStart` 窗口化（以 selected 为中心），显示 `n/total` |
| 8 | `controller.ts:654-657` | **取消挂起时用户被困死**。`#cancelling` 置位后第二次 Ctrl+C 被直接吞掉，产品文档 §4.5 承诺的「第二次 Ctrl+C 强制退出」未实现。若 runtime stop / 清理挂住，TUI 内没有任何出口，只能杀终端 | 首行改 `if (this.#cancelling) return this.#close();` 并提示「再次 Ctrl+C 强制退出」（约 3 行） |
| 9 | `pages/home.ts:110-114` + `controller.ts:176-207` | **建议列表画了高亮光标却完全不可选**。输入 `/c` 高亮 `❯ /config`，按 Enter 得到 "Unknown command: /c"；↑↓ 无反应；`/h` 多命中时 Tab 无反馈 | Enter 时前缀唯一匹配则执行该命令 + 去掉第一项光标符（约 10 行） |
| 10 | `pages/result.ts:23-48` | **结果页缺产品文档承诺的固定客观事实**：无耗时、target turn 数、controller 调用数、token、成本——前三项 running 页头栏一直在算，一到结果页全部丢失；Comparison 只显示一个状态词 | 补一行 `Elapsed · turns · calls`（数据现成）；Comparison 完成时展示摘要首句；token/成本没有就明示 `not recorded` |

### 3.4 工程与隐私

| # | 位置 | 问题 | 修复方向 |
|---|------|------|----------|
| 11 | `docs/tui-live-run/data/`（12.2 MB，未跟踪） | **真实用户会话原始数据待提交**：`case.json` 6.3 MB + `raw/session.jsonl` 5.9 MB，frame 里可见个人项目名。一旦 `git add docs/` 即永久进入历史，与 `.gitignore` 特意忽略 `.reprise*/` 的意图直接矛盾 | `.gitignore` 加 `docs/tui-live-run/data/`（PNG 同理不入库，见 P2） |
| 12 | `scripts/tui-live-run.mjs` | **完全不可复现且触发真实计费**：硬编码个人会话 UUID（`:17`）、`~/.codex/sessions`（`:22`）、个人会话名正则 `/20260810\|汇报ppt/`（`:148`）、自动在确认页按 Enter 真实计费（`:178`）、Chrome 绝对路径（`:234`）。第四轮刚以同样理由删掉 `tui-intake-walkthrough.mjs`，换个文件名又回来了且更严重 | 参数化（会话 ID、目录、Chrome 路径走 env/argv，缺省报错），或整个 gitignore 为用户本地脚本 |
| 13 | `package.json` | **缺 `prepublishOnly`，干净克隆发布得到空包**：`files: ["dist/src"]`、`bin` 指向 `dist/`，而 `dist/` 被 ignore。根目录的 `pack-dry-run.json` 说明确有发布打算 | 加 `"prepublishOnly": "npm run check"`；近期不发布则加 `"private": true` |

---

## 4. P2：健壮性、一致性与体验打磨

### 4.1 协议与存储

- **writer.lock stale 回收「双赢」竞态**（`experiment-store.ts:186-192`）：读 → 判 stale → rm → `writeFile(wx)`，两个进程同时判定 stale 时后者会 rm 掉前者刚创建的新锁，双双持有 writer。改用 `rename` 原子认领 stale 文件。
- **`model/rerouted` 每次通知写两条同类型事件**（`runtime-port.ts:371-375`）：通用 append 已产出一条 raw 版本，`:374` 又 append 一条结构化版本，timeline 渲染两行重复的 "Model rerouted"。删掉重复。
- **对已死进程 `turn/interrupt` 失败把 cleanup 记成 incomplete**（`runtime-port.ts:337-346` → `candidate-run.ts:190-193`）：尽管 `close()` 实际已确认进程干净退出，证据向坏方向失真。`stop()` 内 catch interrupt 错误，由 close 结果决定 cleanup 状态。
- **`finally { await client.close(); await rm(root) }` 吞错并泄漏临时目录**（`text-caller.ts:121-124`、`runtime-port.ts:472-475`）：close 抛错时 rm 被跳过，且 close 错误覆盖 try 块里真正的失败原因。
- **`freezeCodexFixture` 仍是单阶段写入**（`pack.ts:194-209`）：僵尸目录卡死重试，与 `sessions.ts` 刚修好的两阶段语义在同一仓库里两套行为。套用 staging+rename（可抽共享函数）。
- **原子写第三份实现且会泄漏 tmp**（`harness-model-config.ts:54-56`）：直接改用 `core/identity.ts` 的 `writeAtomic`。

### 4.2 应用与证据质量

- **target 侧 `failed`/`aborted` 结算记成 `message: "undefined"`**（`candidate-run.ts:151` + `:347`）：`#finish('failed.runtime','failed')` 没传 cause，兜底生成字面量 `"undefined"` 进 RunOutcome 与报告；且 `aborted` 与 `failed` 挤同一终止码、`origin:'runtime'` 名不副实。至少把 settlement status 放进 failure.message。
- **token 统计从未生效，且语义一旦生效就是错的**（`codex-experiment.ts:340-342`）：真实 `token_count` payload 的用量在 `info.total_token_usage.total_tokens` 下，`tokenValue` 查的四个顶层 key 一个都不在 → 报告 `Tokens:` 永不出现（manifest 却声称 `tokenTelemetry:'partial'`）；`total_token_usage` 是累计值，`+=` 求和一旦生效会产出数倍虚高假证据。按真实形状取值、聚合改「取最后一次」、用真实会话片段做 fixture；短期不修就删掉这段死代码。
- **Controller 每次决策全量 SHA-256 整个工作区**（`codex-experiment.ts:267-269,388-393`）：增量投影只做了事件一半，工作区指纹仍是每轮全内容哈希，几百 MB 仓库 × 每轮决策是 wall-clock 预算内的固定税。可用 size+mtime 先筛。
- **`fingerprintTree` 排序既浪费又不确定**（`local-workspace-provider.ts:320`）：每递归一层对共享数组全量重排（只有最外层必要）；`localeCompare` + OS 分隔符使 digest「本机专属」，跨机器比对会假阳性。改码点比较 + 统一 `/`。
- **预算检查在全量哈希之后**（`local-workspace-provider.ts:99-100`）：几十 GB 的目录要读完算完 hash 才知道被 block。先做 stat-only 预算扫描、通过后再算内容哈希（round-5 P1-2 同一条，两轮独立发现）。

### 4.3 TUI

- **source 页输入行没有光标**（`pages/run.ts:49`）：空时显示 `▌`，一有内容光标就消失，与 config/composer/搜索全不一致——config 事故的同类残留。改 `` `${sourceRoot}▌` ``（1 行）。
- **废弃 config 草稿泄漏到 Home/头栏**（`controller.ts:1045-1047`）：`envNameFromConfig` 优先取草稿 keyRef，而 Esc 回 Home 不重置草稿——改完不保存，Home 此后按**从未保存的**变量名显示 set/missing。回 Home 时丢弃草稿。
- **整个会话的持久化时间戳冻结在启动时刻**（`cli/main.ts:80,96-98`）：`now` 只算一次再以常量闭包传入，开两小时后 freeze 的 TaskCase 时间戳仍是启动时刻，history 排序全并列。CLI 传活时钟，固定时钟只留测试。
- **inspection 候选列表无窗口化**（`pages/intake.ts:134-136,157-158`）：20+ 条消息的会话在 24 行终端里 ↓ 到第 10 条时，选中行与 freeze 预览全在裁剪线以下，用户盲选。围绕选中项开窗。
- **隐私开关提示与作用域不符**（`controller.ts:390-391`）：说「for this TaskCase」，实际是会话级、作用于之后每一次 freeze。进 inspection 时重置，或改文案。
- **pi-catalog 模式下 baseUrl/keyRef 可编辑但保存被静默丢弃**（`pages/config.ts:35-42` + `harness-model-config.ts:157-166`）：按 kind 隐藏不适用字段或禁止编辑。
- **搜索空态文案误导**（`pages/intake.ts:213-215`）：查询无命中显示 "No eligible historical sessions."。区分「有查询无命中」与「无数据」。

### 4.4 工程

- **`test` glob 在 Linux 上「碰巧正确」**（`package.json:21-22`）：`dist/test/**/*.test.js` 未加引号，Ubuntu 的 sh 把 `**` 按 `*` 处理，当前因子目录无 `.test.js` 才原样传给 Node；一旦子目录出现测试，Linux CI 将静默跳过全部平铺测试而 Windows 照跑。加引号强制两平台走 Node 自己的 glob。
- **CI 缺口一组**（`.github/workflows/check.yml`）：`audit:tui` 重复全量构建（加个不带 build 的 `audit:tui:ci`）；无 `concurrency` 取消、无 `timeout-minutes`、actions 未 SHA 固定、`push`+`pull_request` 对 PR 重复跑；覆盖率不运行不上传；无 dependabot——依赖全精确锁定却没有升级信号来源。
- **文档导航失同步，违反自订规则**（`docs/documentation-structure.md:39`）：目录模型只列 2 份 analysis，实际 7 份；`evidence/`、`feedback/`、`plan/`、`progress/`、`tui-audit/`、`tui-live-run/` 等目录在模型中缺席；`further-development-plan.md` 是孤儿且与 `development-plan.md` 同主题双来源；`progress/MASTER.md` 违反小写 kebab-case 规则。
- **根目录游离生成物**：`test-output.txt`（一份「测试红」的陈旧日志，易被误读为当前状态）、`pack-dry-run.json`。删除并按需加 ignore。
- **第四轮全部成果堆在未提交工作树里**：`git log` 仅 3 个 commit，源码/测试/CI/文档归档混在一个巨大未提交状态且有并行进程写入，无法回滚到确定点。先清生成物，再按「src+test / CI+lint / docs」切分提交收口。

---

## 5. P3：简洁克制（可直接删或一行修）

1. **死代码**：`widgets.separator`、`viewport.headerRowCount`/`COMPACT_HEADER_ROWS`、`harness-model-config.safeBaseUrlDisplay` 生产零调用；`resolveKeyRef` 仅测试使用。
2. **死联合成员与假可选**：`CodexExperimentPreflight.sourceBaseline` 的 `'partial'` 无生产路径；`comparisonClass?` 永远被赋值；`CodexTuiWorkflow.policy?` 永不为 undefined。三处都在制造读者负担。
3. **过拟合单个用户的数据进了产品代码**（`pages/intake.ts:49-56,42-44`）：`sessionTitle` 硬编码 `对于"…"这个ppt` 剥离规则；`projectLabel` 返回中文 `'其他'` 混在全英文界面里。
4. **重复**：`formatBytes` 在 `history.ts:62` 与 `run.ts:241` 各一份；`SAFE_RUNTIME_ID`（`runtime-port.ts:51`）与 `core/identity.SAFE_ID` 完全相同；`runtime-port.ts:65-82` 同一段 jsdoc 出现两次且第一份挂错对象。
5. **协议边角**：字符串 JSON-RPC id 的 server request 被当通知静默吞掉（`runtime-port.ts:200-211`，协议允许 string id）；catalog 缓存 key 忽略 `env`（不同 CODEX_HOME 共享快照，`:449`）；`experiment-store.ts:234` 动态 import `readdir`（顶部已有静态 import）；`close()` 删锁不校验 nonce（`:202-207`）。
6. **证据边角**：`cleanup.evidenceRefs` 指向 `run.outcome_created` 而非真正的清理证据事件，且 journal 与 record.json 两份副本不一致（`candidate-run.ts:269-274`）；`reportExists` 整读文件当存在性检查、comparison.md 被读两遍、`write_comparison_report` 是裸 writeFile（`codex-experiment.ts:521-523`、`agent-tools.ts:51`）；`assertComparisonResult` 名不副实只查了 evidenceRefs（`comparison-agent.ts:56-61`）。
7. **TUI 边角**：150 条会话上限静默截断不提示（`controller.ts:531`）；`#hasCodexLogin` 仅启动探测一次（`:140`）；文本编辑无 ←→/Home/End；`#detailExpanded` 不随新实验重置（`:696-700`）；timeline `+N` 标记语义偏差（`run.ts:205-206`）；消息染红启发式 `/error|fail/i` 会把含 "fail" 的成功消息整行变红（`workbench.ts:171`）；`#preparedRoots` 只增不减（`local-workspace-provider.ts:159`）。
8. **测试卫生**（第四轮点名未改）：`widgets.test.ts:82,89` 硬编码 `C:\Users\15893\...`（泄露用户名）；`baseline.test.ts` 名不副实应并入 `cli.test.ts`；`codex-pack.test.ts` 依赖 PATH git 无 skip guard；`waitFor` 上限 500ms 慢 CI 有翻车面；`@types/node` 24.x 对 engines 22.x 放行不存在的 API。

---

## 6. 功能完整性：产品文档承诺 vs 实现

| 承诺（`docs/product/tui.md`） | 状态 |
|---|---|
| §2/§3.3 **候选模型选择**（从 Runtime 发现/验证候选并让用户选） | **未实现，主路径最大功能缺口**。候选完全由 workflow 固定，`main.ts:92` 硬编码 effort `'high'`，TUI 全流程没有选择候选的步骤。需要产品决策；在此之前至少在 confirm 页明示「候选模型不可在 TUI 中更换」，并让 tui.md 停止承诺 |
| §4.5 第二次 Ctrl+C 强制退出 | 未实现（P1 #8） |
| §4.5 关闭 TUI 时运行中任务「不自动取消」 | **实现与文档相反**：`#close()` 会 cancel 活动实验，且第四轮把这当成修复宣传。建议改文档（第一版无 detach，取消是更安全的语义），但要写明 |
| §4.3/§6 token・成本统计 | running 页无 token/成本；result 页连耗时/调用数都没有；且 token 采集管线本身是死代码（P2 §4.2） |
| §4.1 折叠重复低价值事件 | 未实现，仅靠白名单丢弃噪声 |
| §4.4 近原生只读 Runtime 会话视图 | 未实现，detail 面板是近似替代 |
| §6.1 Comparison 摘要展示有区分度观察 | TUI 只有状态词，观察只在 HTML 报告 |
| §9 窄终端不依赖右侧面板完成相同操作 | ✔ 达成 |

另：首次 `/run` 时应有一句不可误解的提示——「Reprise 会复制所选目录；隔离副本不是隐私清洗」（round-5 P1-4，赞同保留）。

---

## 7. 测试盲区的共同根因与永久防线

本轮三个 P0 各代表一类系统性漏检，值得当成模式修：

1. **恒真测试**（P0-1）：断言「坏输入被拒绝」而没有对应的「好输入被接受」正向用例时，校验逻辑本身坏掉也全绿。凡是拒绝路径测试，配一条接受路径。
2. **mock 输入测不到真实终端**（P0-3）：与 config 编辑器事故同构。建议把「真实 `TuiAltScreen` + `FakeTerminal` + 带 bracketed-paste 标记的输入”纳入回归套件；layout 渲染路径（ScrollView 钉底问题所在）目前零测试覆盖，全部断言走字符串路径。
3. **事件名从未做端到端断言**（P0-2）：runner 直发事件与客户端合成事件走不同前缀路径，恰好只有前者被测过。补 fake app-server 的 server-request 与 mid-turn `process.exit(1)` 两条协议级测试。
4. **生产 payload 形状从未进 fixture**（token 死代码）：`comparison-report.test.ts` 手工喂 `tokenCount: 128` 掩盖了链路断裂。关键投影用真实会话片段做 fixture。

---

## 8. 建议执行顺序

**第一批（半天内，消除主路径失败与错误证据）**

1. P0-1　marker 移出指纹范围 + 正向测试（约 5 行 + 2 条测试）
2. P0-2　`#emit` 传裸名 + `timeline.ts:73` 改回 + rejectedApprovals 端到端测试（约 10 行）
3. `docs/tui-live-run/data/` 与 PNG 补 ignore；删 `test-output.txt`、`pack-dry-run.json`（5 分钟）
4. P0-3　bracketed paste 解包 + 粘贴测试（约 15 行）

**第二批（一天，崩溃归因与用户出口）**

5. runner `onClosed` + `process.exit(1)` 测试（P1 #1）
6. spawn 路径加引号（P1 #2，1 行）+ journal 尾修移入持锁后（P1 #3）
7. 二次 Ctrl+C 强制退出（P1 #8，约 3 行）+ 建议列表 Enter（P1 #9）+ source 光标（P2，1 行）
8. `prepublishOnly` + test glob 引号（2 行）

**第三批（一到两天）**

9. `allowModelText` 观察工具门控（P1 #4）
10. baseline 捕获两阶段提交（P1 #5）+ open-report 假成功（P1 #6）
11. 列表窗口化三处（P1 #7）+ result 页统计行（P1 #10）
12. `tui-live-run.mjs` 参数化或移出仓库（P1 #12）

**第四批（按需，先测量再做）**

13. P2 各条按序；token 管线修复或删除；预算早停与工作区指纹增量**先测真实耗时再动手**
14. 工作树分批提交收口；文档导航同步

**明确不做**（延续第四/五轮共识）：多 Product 通用抽象、报告 Markdown 渲染、真实 smoke 进 CI、hardlink/reflink 快照、状态机框架/事件总线、精确成本估算、为拆而拆 controller.ts（当前 1053 行主体是有真实读写的状态机，先抽 `intake-input.ts` 一刀即可，见 TUI 审查 §三）。

---

## 8.1 实施收口（2026-08-13）

本轮已按上述优先级完成可局部验证、且不依赖外部付费调用的修复：

- **P0-1**：baseline marker 改存于 baseline 根目录外；捕获采用 staging + rename，既不污染 fingerprint，也不会复制进 Candidate 工作区；覆盖未变源的 preflight 正向启动和失败清理。
- **P0-2 / P1 协议项**：Codex 合成事件仅加一次 `codex.` 前缀，兼容 string JSON-RPC id；被拒 server request 与进程异常退出均进入 journal，`waitForTurn()` 即时失败；Windows `.cmd/.bat` 启动路径已加引号。
- **P0-3 / P1 TUI 项**：所有 Controller 输入入口先解 bracketed paste；唯一命令前缀可 Enter 执行；取消挂起时第二次 Ctrl+C 强制关闭。projects、sessions 和 history 均以选中项为中心窗口化并显示 `n/total`。
- **隐私与存储**：`allowModelText: false` 时 transcript assistant text 与 run-event 中的 `text` 字段均在 observation tools 处脱敏；ExperimentStore 只有取得 writer lock 后才截断损坏的 JSONL 尾行。
- **结果与 telemetry**：结果页展示 elapsed、target turns、controller calls、token（不可用时明确 not recorded）及 Comparison 首句。真实 Codex `total_token_usage.total_tokens` 是累计值，因此投影保留最后一条有效值，不做累加；已添加 `128 → 256` 的回归，防止错误得到 `384`。

刻意未扩展：真实 provider/Codex smoke 仍需用户显式 opt-in；工作区扫描与历史目录统计优化继续遵循 round-5 的测量停止线；不实现精确成本估算、候选模型选择或 controller 大拆分。

当前实施状态（以当前工作树为准）：

| 需求 / 风险 | 实现与回归证据 | 当前状态 |
|---|---|---|
| P0/P1 生命周期、store、fixture、runtime、baseline 与事实投影 | 对应模块直接测试已在本轮分别运行；真实 provider 调用未纳入确定性验证 | 已实现；最终门禁待重跑 |
| TUI 120 列 detail pane 宽度 | 曾复现 `progressBar()` 返回 39/120、空分隔行返回 0/120；现由 `pad()` 统一补齐，`npm run build` 后 `node --test "dist/test/widgets.test.js"` 为 36 passed、0 failed | 已修复并针对性验证 |
| 完整本地门禁和补丁空白检查 | 早先成功记录不覆盖之后的工作树修改 | 待执行 `npm run check` 与 `git diff --check` |
| 真实 Codex/provider smoke | 会执行外部调用并可能产生费用，未获明确 opt-in | 明确未运行 |

因此，不再把先前的完整门禁记录表述为当前工作树的最终结论。2026-08-13 已在当前工作树实际执行 `npm run check`（175 passed、0 failed，typecheck、ESLint、build 与 CLI `--version` 均退出 0）及随后 `git diff --check`（退出 0）。真实 provider/Codex smoke 仍未运行，因为它可能产生外部调用与费用。

---

## 9. 最终判断

核心域的质量依然高于同规模项目：状态机幂等、崩溃一致性、密钥边界、XSS 防护经四轮打磨后确实扎实。但本轮证明了两件事：

1. **修复本身需要回归防线**——最严重的 P0 是上一轮 P0 修复引入的，且被恒真测试掩护；
2. **「测过」不等于「用真实通道测过」**——粘贴失效、ScrollView 钉底、双前缀事件、token 死代码，全部落在 mock 与真实之间的缝隙里。

做完第一、二批后，最有价值的投入不是继续找新问题，而是把 §7 的四条防线补进测试资产，然后让真人在真实 PowerShell 里完整跑一次计费实验——那次运行会比第七轮 review 更有信息量。
