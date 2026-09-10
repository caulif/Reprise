# 规划：候选用户表面拼接与 Git 主线隔离

样本 N6（实验 `recovery-a7705746-…`，候选 Claude Code）暴露两处缺口：Controller 只读到一轮里最后一句可见正文；隔离副本的 `origin` 仍指向用户 GitHub，`git push` 打到真远端。本文件是实施目标，不是当前规范。

## 完成判据

- 一轮内多段公开 `text` 按事件顺序进入 `UserVisibleTurn.assistantText`（段间 `\n\n`）；thinking / tool_use 不进表面。
- Controller 的 `current-user-view.md` / `turns/*/user-view.md` / `visible.txt`，以及 Comparison 只读挂载的同一 `turns/`，都是这份拼接全文；Comparison **不另写**一套投影。
- `inspectRunFacts` 在**整次 run** 上的 `finalMessage` 仍是最后一段公开正文（会话/对照摘要），不得把多轮拼成一条。
- Intake 列表、`TaskCase.baseline.finalMessage`、历史 inspect 仍取会话最后一条助手句。Recovery 继续只读冻结 `observations/`，不消费 `UserVisibleTurn`。
- `prepareRun` 之后，工作副本及嵌套仓 / submodule 的 `origin`（含 https/ssh/`pushurl`）只指向本 run 的 Harness bare sink；对 sink `git push` 成功。
- 对用户真实 origin 的 ref 做 push 不得更新该远端（反向用例必须红）。
- Recovery staging 在成为 Harness 树之后同样改写 remote。
- 候选进程带 run 级 `GIT_CONFIG_GLOBAL`：把**已记录的** origin URL 别名 `insteadOf` 到 sink；不继承 `GITHUB_TOKEN` / `GH_TOKEN`。
- Comparison 用 sink 的 ref 判断「是否推送」，不把 GitHub 当实验远端。
- `npm run check` 通过。同批 ADR + 架构一句更新。

## 不在本批

- 容器 / 防火墙级断网；`gh`、浏览器、任意 `curl` 到 GitHub 仍标外部世界不受控。
- 禁止隔离副本内 `git commit`（任务语义需要提交）。
- 回写或 reset 用户已经推上 GitHub 的 commit。
- 把 TUI 主列改成展示一轮全部正文（主列仍可截断；完整表面在 `user-view.md`）。
- 修复 Windows `read` 反斜杠路径（另案）。
- `observations/` 单文件 8000 字符从头 excerpt（`file_char_limit`），以及 Recovery 工作集 `initialInput` 8000 字截断。与候选 last-only 不同类，不并进 V。

---

## 一、用户可见表面

### 问题

[UserVisibleTurn](../decisions/accepted/2026-09-09-candidate-runtime-events.md) 必须是真人在产品 UI 里、该 settled 区间内能看见的助手正文。Claude stream-json 一轮会发出多帧 `assistant`：先短叙述、再长文、再一句收束。Pack 用 `texts.at(-1)` 只留收束。N6 第一轮 4 段公开 text（约 9129 字）落盘只剩 42 字；Controller 在残缺视图上 `correct`。

[按 settlement 区间取视图](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md) 已经禁止「用整次 run 最后一条当当前轮」。缺口是**区间内部**仍 last-only。

### 同类扫描（要改 / 不要改）

| 位置 | 行为 | 本批 |
|---|---|---|
| [`claude-code/projection.ts`](../../src/products/packs/claude-code/projection.ts) `texts.at(-1)` | 一轮多段 text 只留最后 | **改**：有序列表 + 表面拼接 |
| [`codex/projection.ts`](../../src/products/packs/codex/projection.ts) `agentMessage` `.at(-1)` | 一轮多条 `agentMessage` 同样截断 | **改**：同一拼接规则 |
| [`test/fixtures/fake-pack/projection.ts`](../../test/fixtures/fake-pack/projection.ts) | 与上相同 | **改** |
| [`projectUserVisibleTurn`](../../src/products/contract.ts) | `assistantText = facts.finalMessage` | **改**：表面字段与 run 级 `finalMessage` 分开 |
| [`controller-queries.ts`](../../src/application/controller-queries.ts) `turnVisibleText` | 跟 turn 切片的 `finalMessage` | 跟投影走，变成拼接结果 |
| [`controller-queries.ts`](../../src/application/controller-queries.ts) 整 run `facts.finalMessage` | 对照/摘要用「最后一段」 | **保持 last** |
| Claude/Codex `sessions.ts` / `pack.ts` 历史 `baseline.finalMessage` | 冻结会话预览 | **不改** |
| TUI Intake `compact(inspection.finalMessage)` | 列表预览 | **不改** |
| `visible_prompt` `.at(-1)` | 当前确认条 | **不改** |
| TUI 主列 `compact` 可见回复 | 展示宽度 | **不改**；`original` / user-view 必须是全文 |
| Claude/Codex 历史 `sessions.ts` 同行多段 `text` | 已 `join` 进 `TaskCase.transcript` | **不改**（没有候选 last-only） |
| Recovery 工作集 / `observations/` | 指针 + 单文件 8k 头切 | **不改**（见「不在本批」） |
| Comparison `turns/` 挂载、`candidate/user-view.md` | 消费 Controller briefing | **不改代码**；随 V 自动变完整 |
| Comparison `facts/context.json` run 级 `finalMessage` | 整次 run 最后一段摘要 | **保持 last** |

### 谁读什么（Recovery / Controller / Comparison）

候选 `visible_output` 的 last-only 只发生在 **Pack 把一轮多段公开 text 收成 `UserVisibleTurn` / `turnVisibleText` 之后**。下游谁吃这份表面，谁就继承同一残缺；谁吃冻结历史或原始事件，谁就不走这条路径。

| 读者 | 能读到的正文 | 与 last-only 的关系 |
|---|---|---|
| **Recovery** | 候选开始前：冻结 `observations/`（历史 `transcript` + `historicalEvents` + 当时已有 run 事件）。工作集 JSON 只带 `initialInput`（超过 8000 字截断并标 `truncated`）和路径指针，完整材料靠 `read`/`grep`。**不消费** `UserVisibleTurn`、不挂候选 `turns/`。 | **不继承** 候选投影 last-only。历史 Claude/Codex **同一 JSONL 行 / 同一 message 内**多段 `text` 已 `join`（Claude `parseAssistantRow` 用 `\n`；Codex content parts 同样 join）。历史 `baseline.finalMessage` 仍是会话最后一条助手句，只作线索。 |
| **Controller** | 必读 `current-user-view.md` / `turns/*/user-view.md` / `visible.txt`（同源：`turnVisibleText` + `userView.assistantText`）。`history/transcript/*.txt` 是 **TaskCase 全文**，无 8k 帽。压缩后须再读磁盘，磁盘残缺则无法补全。 | **继承** last-only。V 修好后这三处一起变完整。历史侧本来就完整。 |
| **Comparison** | `turns/*/user-view.md`（只读挂载 Controller briefing）；`candidate/user-view.md` 只拷 **当前**（最后一轮）视图，更早轮次在 `turns/`。`history/transcript/` 与 Controller 同源全文。`facts/context.json` 里 run 级 `finalMessage` / `baseline.summary` 是「最后一段」**摘要**，规范要求当主张去核对，不当唯一证据。`observations/` 另有一份冻结事件/transcript JSON。 | 候选过程对照 **继承** last-only；修 V 后 `turns/` 与对照一起修好。历史交付对照走 `history/` + git/快照，不依赖候选表面。N6 用 git diff 判仓内结果，第一轮长文缺失主要伤「过程/首轮形态」，不伤「改了哪些文件」。 |

另一类截断，**不是** last-only，不并进 V：

[`observations-materializer.ts`](../../src/products/history/observations-materializer.ts) 每个 observation 文件 JSON 超过 **8000 字符**时只保留 **开头** excerpt（`file_char_limit`）。Recovery 读历史长助手句、Comparison 从 `observations/events/` 读单帧 `visible_output` 都会撞上。N6 第一轮单段约 8971 字：即使去读 raw 事件副本，observations 里也会被切掉尾部。完整候选表面的权威副本是 briefing `user-view.md`（修 V 之后）和事件日志本身；`history/transcript/*.txt` 无此帽。

压缩（`agent.context_compacted`）按设计丢掉长正文、留路径；路径指向的文件若残缺，压缩救不回来。

Recovery 要的是起点线索（cwd、commit、工具记录、文件路径），不是复述历史长文。8k 头切会丢掉落在文件**尾部**的 SHA/路径；工具调用在历史里常是单独 `tool` 行，多数仍在。Comparison 要的用户需求索引在 `observations/user-inputs/` 与 `history/user-inputs/`，助手长文以 `history/transcript` 为准。

### 目标契约

`TargetRunFacts` 增加有序公开正文（名字以代码为准，例如 `assistantTexts`）。

- 收集：事件顺序；只取公开 `text` / Codex `agentMessage.text`；跳过 thinking、tool_use、空串。
- `finalMessage` = 该事件集合的最后一段（整 run inspect 与历史预览语义不变）。
- `projectTurn` 的 `assistantText` = 该 **turn 事件切片** 上各段 `trim` 后用 `\n\n` 连接。无公开正文且 completed → 仍 `empty`。
- 拼接逻辑放 `products/contract.ts`（或 `products/shared/`），三个 Pack 共用，禁止各写一份 `.at(-1)`。

### 选用

**拼接进单一 `assistantText`。** 不把 schema 改成字符串数组：Controller / TUI / Comparison 已按一篇用户可见回复消费。

放弃：只改 Claude；放弃：整 run `finalMessage` 也拼接。

### 实施切片 V

| id | 做什么 |
|---|---|
| V1 | 契约：`assistantTexts` + `joinPublicAssistantSurface`；`projectUserVisibleTurn` 用拼接结果 |
| V2 | Claude / Codex / Fake Pack 收集有序 text；去掉 turn 表面的 `.at(-1)` |
| V3 | 测试：两段 text 的 turn，`user-view.md` / `visible.txt` / `assistantText` 含第一段；thinking 不出现；整 run inspect `finalMessage` 仍是最后一段。Comparison 挂载同一 `turns/`，不另测一套投影 |
| V4 | ADR：补充「区间内全部公开 text」。改 [controller.md](../architecture/controller.md) 一句：区间内拼接，不是区间内最后一段。更新 [controller-permissions-view-prompt](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md) 或新 ADR 指向它。Comparison 架构一句：过程对照读拼接后的 `turns/*/user-view.md` |

反向用例：fixture 含「短叙述 + 长文 + 收束」三帧，断言若只等于收束则失败。

---

## 二、Git 主线隔离（方案 A + 两道补丁）

### 问题

[`prepareRun`](../../src/environment/local-workspace-provider.ts) 整树拷贝，`.git/config` 的 `origin` 原样进入副本。候选继承用户 Git 凭据。N6 副本 `origin` 为 `https://github.com/caulif/myblog.git`，HEAD `59616da`；本机 `C:\blog` 仍 `294c695`。真远端被推送；候选 `pull origin` 还会把历史任务后的 `294c695` 拉回，污染对照。

工作区路径隔离有效；Git 拓扑与凭据未隔离。Recovery 内部工具有临时 `GIT_CONFIG_*`；**候选 Runtime 没有。**

### 目标

Harness 拥有的树（Recovery staging、published baseline、`prepareRun` 副本）里，每个 Git 仓库（根、嵌套如 `caulif/`、submodule）的 push/fetch 默认只对 **本实验 bare sink**。sink 在拷贝当时从该仓库 HEAD 建出，不 `clone` 用户 GitHub。隔离副本内允许 `commit`；`push` 更新 sink 的 ref。

对照只读 sink（及副本本地 HEAD）。把「是否推到 GitHub」写成能力差是禁止的；标 replay / 配置差异。

### 选用

**A. 每仓一个 `environment/git-sinks/{runId}/…git` bare 接收端，改写 remote URL。**

补丁 1：run 级 `GIT_CONFIG_GLOBAL` 对**已记录的** origin URL（https / `ssh://git@` / `git@host:path`）做 `insteadOf` → 对应 sink。不把整个 `github.com` insteadOf 掉（会破坏 `npm`/`go` 拉依赖）。

补丁 2：候选 spawn env 不继承 `GITHUB_TOKEN`、`GH_TOKEN`；Git 配置根与 Recovery 一样指到 run 临时 HOME（`GIT_CONFIG_GLOBAL` / `NOSYSTEM`）。SSH agent 无法在无容器 Windows 上机械拔掉，靠 URL 改写挡住默认 `origin`。

放弃：只删 remote 让 push 失败（会扭曲「请提交并推送」任务）。放弃：仅抽凭据、不改 origin（URL 仍是真仓库）。

### 实施切片 G

| id | 做什么 |
|---|---|
| G1 | `isolateGitTopology(tree, sinkRoot)`：发现 `.git` 与 submodule；为每个仓建 bare；改 `remote.*.url` / `pushurl`；改写 `.gitmodules` 里已出现的同一 URL |
| G2 | 在 staging 首次成为 Harness 树之后、baseline publish、`prepareRun` 拷贝之后调用；幂等 |
| G3 | 候选 Launch/env：临时 gitconfig + insteadOf 别名 + 去掉 GitHub token 环境变量。不按 `productId` 分支，走 Environment / spawn 公共路径 |
| G4 | Comparison briefing：挂载或摘录 sink `refs`；报告禁止把用户 origin 当实验远端 |
| G5 | ADR + [environment.md](../architecture/environment.md) `prepareRun`：副本 Git remote 必须是 Harness sink |
| G6 | 测试：fixture 仓带 `origin` 指向临时「用户远端」；`prepareRun` 后对该 URL `git push` 不得前进用户远端 HEAD；对 sink push 前进。嵌套仓至少一例。反向：拷贝后仍写用户 URL 则红 |

Windows：sink 用 `file://` 或 git 接受的绝对路径；`.cmd` / `spawnRuntimeProcess` 与现有进程约定一致。

失败模式：模型新建未记录的 GitHub URL 并 push——补丁 1 挡不住未知 URL。第一版记 `externalWorld: uncontrolled`，不在本批做协议级 Git 代理。

---

## 顺序与文档

先 V 后 G（V 不碰用户远端）。可以两个 PR，本文件仍是同一目标。V 的读者扫描已关闭：只改 Pack 投影与 `projectUserVisibleTurn`；Recovery 不改；Comparison 不另写投影。

跨模块协议 / on-disk（user-view 语义、environment 布局增加 `git-sinks/`）必须同批 ADR。不在 Pack 外按产品类型写隔离。

## 依赖阅读

- 可见表面：[Runtime 事件](../decisions/accepted/2026-09-09-candidate-runtime-events.md)、[按区间取视图](../decisions/accepted/2026-09-09-controller-permissions-view-prompt.md)、[时间线](../decisions/accepted/2026-09-10-user-visible-turn-timeline.md)、[对照 briefing](../../src/application/comparison-briefing.ts)、[Recovery 工作集](../../src/agents/recovery-working-set.ts)
- Git：[环境](../architecture/environment.md)、[LocalWorkspaceProvider](../../src/environment/local-workspace-provider.ts)、Recovery 净化环境 [`sanitizedEnvironment`](../../src/infrastructure/recovery-workspace-tools.ts)
