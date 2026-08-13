# Reprise Intake / Inspection 实测优化意见

> 对照：`TUI-DESIGN.md` §6.3–6.4。本文用**本机真实 Codex 会话**走完 `/intake → freeze → /run` 确认页，不启动计费 Candidate。
>
> 目标会话：`019ff9fd-62c5-76b3-ba67-beed462fe746`
> 工作区：`C:\yanjiusheng\本子与项目撰写\CNCERT项目-漏洞整理\20260810汇报ppt`
> 信号：users 3 · assistant 4 · tools 60 · completed 3 · JSONL 约 6.1 MB
>
> 证据：`docs/tui-intake-review/`（14 帧文本 / HTML / 截图）。`docs/` 被 gitignore。重跑：`node scripts/tui-intake-walkthrough.mjs`。

---

## 0. 结论

你的直觉是对的：**会话列表和点进去之后的审查页，都还不是「选一个项目里的一次任务」**。

当前 intake 是「全盘最新 50 条按时间拍扁」。本机实际有 **1269** 条 rollout（约 3.5 GB），200 条抽样里就有 **76** 个不同 `cwd`。列表里 PPT 改稿、Reprise 开发、Clash、CS2、膝盖筋、Hugging Face 挤在同一张表。点进审查页后，UUID、jsonl 路径、整段第一句用户输入、三条候选起点、整篇 Final **叠在同一块板里**；32 行终端会把「Privacy / 按 Enter 才会写入」裁掉。上下移动 1/2/3 时，上面的 Task 和下面的 Final **完全不变**，所以会觉得「选了也没发生什么」。

Grok Build 已经把这件事做成两套互补交互，值得直接学，而不是再发明一层：

| Grok Build | 做什么 | Reprise 应对齐的点 |
|---|---|---|
| `/resume` 选择器 | 打字即过滤标题；内容命中进 *Extended search results*；`Ctrl+/` 立刻搜 | 会话列表需要 **live search** |
| `grok sessions list` | **按当前工作区 / worktree 分组** | 先项目、再会话；无 cwd 进 **其他** |
| `grok sessions search` | 本地 FTS5 索引标题和 prompt | 第一版用已加载摘要做子串即可，不必先上 SQLite |
| Dashboard `Ctrl+G` | 在 state 与 **directory** 分组间切换 | Reprise 默认就该按 directory |
| Dashboard `Ctrl+/` | `Search:` 前缀，键入即过滤 label + cwd | `/` 或 `Ctrl+/` 切到搜索，不要和 Home 的 slash 命令抢 |

下面按走查顺序写问题和改法。

---

## 1. 走查范围

驱动真实 `CodexIntakeTui`，`--sessions-dir` 默认的 `%USERPROFILE%\.codex\sessions`，配置从仓库 `.reprise` 拷到临时 `data-dir`。确认页**没有**按 Enter，避免对 CNCERT PPT 目录起隔离 Codex 进程。

| 帧 | 步骤 | 宽×行 |
|---|---|---|
| `01-home` | Home | 120×15 |
| `02-sessions-wide` | `/intake` 列表 | 120×62 |
| `03-sessions-compact` | 同上，60 列 | 60×62 |
| `04`–`07` | 审查页：无高度 / 32 行 / 24 行 / compact | 120 或 60 |
| `08`–`10` | 任务起点 2 / 3 / 回到 1 | 120×32 |
| `11-home-after-freeze` | Enter 冻结后 Home | 120×15 |
| `12`–`14` | `/run` 源目录 → preflight → 确认 | 120 |

---

## 2. 逐步现象

### 2.1 会话列表：时间线垃圾场

![列表 120 列](docs/tui-intake-review/screenshots/02-sessions-wide.png)

默认标题是 `Codex sessions · 50 found · filter: all`。选中行（就是目标会话）摘要被截成：

```text
❯ 2026-08-13 07:19  对于"C:\yanjiusheng\本子与项目撰写\CNCERT项… u3 a4 t60
```

同一屏还能看到：Reprise `/goal`、配 Cursor、Hermes 接 Grok、Clash Verge、CS2 安装、膝盖筋、以及五条几乎一样的「按照这个规划实现《Reprise …》。

| ID | 严重度 | 现象 | 根因 |
|---|---|---|---|
| L1 | P0 | 50 条按时间混在一起，看不出项目 | 只有 `startedAt` 排序，没有 `cwd` 分组 |
| L2 | P0 | 本机 1269 条，UI 只露最新 50；更早的 CNCERT 会话直接消失 | `discoverCodexSessions(..., 50)` 且先 **inspect 全部路径再 slice** |
| L3 | P0 | 没有搜索。找不到「PPT / CNCERT / 中期报告」只能盲翻 | `#sessionsInput` 只有 ↑↓ / Enter / `f` |
| L4 | P1 | 行宽不够时 `t659` 掉到下一行，表格错位 | `table()` 单元格超宽后 `panel` 再 wrap，信号列和摘要撕开 |
| L5 | P1 | Preview 里 Session UUID、Workspace、Task 都从路径/提示词原文截断，Workspace 在「CNCERT项目-漏」处断开 | Preview 用 `kv` + 窄列，没有「项目名」字段 |
| L6 | P1 | 五条 Reprise 规划会话标题几乎相同，只能靠 `u6 a11 t42` 这种信号区分 | 没有相对时间、没有 cwd 短名、没有去重提示 |
| L7 | P2 | compact 60 列更看不出项目，只剩日期 + 半句 | 单行表在窄屏没有第二行放 cwd |

`f` 只在 eligible / all 之间切，对「我想找 CNCERT 那个 PPT」毫无帮助。

### 2.2 审查页：信息堆叠，动作不明确

这就是你截图里的页。无高度限制时长这样：

![审查页（完整）](docs/tui-intake-review/screenshots/04-inspection-unbounded.png)

32 行真实终端（常见高度）会把 Privacy 和「Nothing is written until you press Enter」裁掉：

![审查页 32 行](docs/tui-intake-review/screenshots/05-inspection-32rows.png)

24 行时 Final 只剩半句，底边框都没了：

![审查页 24 行](docs/tui-intake-review/screenshots/06-inspection-24rows.png)

| ID | 严重度 | 现象 | 根因 |
|---|---|---|---|
| I1 | P0 | 页标题是 Review session，脚注是 Freeze immutable TaskCase。用户不知道「现在在选哪一条用户消息当历史任务起点」 | 设计把元数据、候选起点、Final、隐私塞进同一 `panel` |
| I2 | P0 | `Task` 整段第一句用户输入，下面 `Task input 1/3` 又是同一句，列表第 1 项还是同一句，三份重复 | `summary`、`taskLine`、`candidates[0]` 同源 |
| I3 | P0 | ↑↓ 只改列表光标和 `Task input N/M` 头。`Task` / `Final` / `Workspace` 不变，所以「选了也不知道有什么用」 | 审查页没有「将冻结这条」的专属预览 |
| I4 | P0 | 32 行裁掉同意文案；24 行裁掉 Final 后半和底框 | `clipLines` 从面板顶往下砍，重要决策区在底部 |
| I5 | P1 | Workspace 显示 `CNCERT项目-漏…`，Source 独占两行 jsonl 绝对路径 | 路径按列宽截断，没有 `basename(cwd)` 项目名 |
| I6 | P1 | Final 是长助手收尾，占满决策区，却**不是**当前要冻结的内容 | 把「会话结局」和「任务起点」当成同一优先级 |
| I7 | P2 | compact 审查变成 69 行说明书，路径按字节折在「漏 / 洞整理」中间 | 无高度时 panel wrap 全文 |

列表第 2、3 条其实很清楚（「请你给出修改后的这几页的ppt」「你自己截图看看…」）。真正难的是第 1 条被绝对路径淹没，以及页面没有说：**Enter = 把当前高亮的那条用户消息写成不可变 TaskCase**。

### 2.3 冻结之后：Home 仍不像「已选中那个 PPT 任务」

![冻结后 Home](docs/tui-intake-review/screenshots/11-home-after-freeze.png)

| ID | 严重度 | 现象 |
|---|---|---|
| H1 | P1 | 右侧 TaskCase 是 `case-c605592a556f3c54`，Source 是产品名 `codex`，不是 PPT 目录或任务短句 |
| H2 | P2 | Recent 仍是 `no local experiments`（还没 /run，文案成立，但和刚冻的案例并排时像没选中） |

消息行写了 `use /run when ready`，这一步本身还算清楚。

### 2.4 `/run` 三步：比 intake 清楚，仍有两处噪音

源目录预填了真实工作区，这是对的：

![Source](docs/tui-intake-review/screenshots/12-run-source.png)

Preflight 显示 Baseline available、Limitations 说明「从目录**当前**状态重放，不是历史那一刻」——对这条 PPT 会话特别重要（磁盘上已有修改页 pptx）。

确认页 Candidate 是 `gpt-5.6-luna · medium reasoning`，而 CLI 里 Codex runtime port 默认 effort 是 `high`。头栏又是 Harness 的 `gpt-5.6-terra · medium`。三条「谁在跑、用多大力气」容易混。

**未按 Enter。** 对这条会话按确认会在隔离副本里再跑一轮 60+ 工具的 PPT 改稿，费用和时间都不适合当 UI 走查。

---

## 3. 从 Grok Build 学什么（只学交互，不搬产品形态）

Grok 的会话是「按工作区归档的对话」；Reprise 的会话是「按工作区归档的历史任务候选」。对象不同，**导航模型可以相同**。

1. **先目录、后条目**
   `grok sessions list` 按 worktree 分组；Dashboard 可用 `Ctrl+G` 改成按 working directory。Reprise 的 `cwd` 就是项目。无 cwd 或无法解析的进 **其他**。
2. **选择器即搜索**
   `/resume`：进入后直接打字过滤标题；内容命中单独成组。Reprise 列表页应有 `Search:` 槽，过滤 `summary`、`cwd`、短 session id。
3. **搜索和命令分开**
   Grok Dashboard 用 `Ctrl+/` 进搜索，避免和 dispatch/`/` 冲突。Reprise Home 的 `/` 已经是 slash 命令；**intake 页**里 `/` 或 `Ctrl+/` 应切搜索，而不是再弹命令补全。
4. **分组可折叠**
   Dashboard 的 Inactive 默认收起。Reprise 一个目录下十几条近重复会话（Reprise 规划 ×5）应默认只露最新一条 + `N more`。
5. **第一版不要 FTS5**
   Grok 的 SQLite 索引是为全盘 prompt 搜索准备的。Reprise 当前连 50 条摘要都没搜。先对**已发现列表**做即时子串；发现层再改成「按 mtime 取 N 条 + 按 cwd 聚合」，不要再全量 parse 1269 个 jsonl。

---

## 4. 建议的信息架构

保持公开 API 和 slash 闭环：`/intake` 仍是入口。改的是 **两级浏览 + 审查页只做一件事**。

### 4.1 项目列表（`/intake` 第一屏）

```text
┌─ Projects · 76 · 1269 sessions ──────────────┬─ Preview ─────────────────────┐
│ ❯ CNCERT…/20260810汇报ppt           12  今天 │  Path   C:\yanjiusheng\…\ppt  │
│   Reprise                               10  今天 │  Latest  改中期报告 PPT        │
│   model-test                            19  昨天 │                              │
│   lhp                                   34  3天前 │                              │
│   其他                                   8  —    │                              │
└──────────────────────────────────────────────┴──────────────────────────────┘
 Search: _          [Enter] Open project  [/] Search  [Esc] Home
```

规则：

- 项目键：规范化后的 `cwd`（大小写合并，`C:\obsidian` 与 `c:\obsidian` 算一个）。
- 显示名：`basename(cwd)`，重名时显示父目录。
- 无 `cwd` → **其他**。
- 排序：最近一次会话时间，不是字母表。
- 行上只放：项目名、会话数、相对时间。不要放 UUID，不要放整段 prompt。

### 4.2 项目内会话（第二屏）

```text
┌─ 20260810汇报ppt · 12 sessions ──────────────┬─ Preview ─────────────────────┐
│ ❯ 今天 15:19  改中期报告 PPT · 三列技术路线   │  Started  2026-08-13 15:19    │
│   3天前      根据 CNCERT… 做修改              │  Signals  u3 a4 t60 · 完成 3  │
│                                              │  First    对于这个 ppt…       │
└──────────────────────────────────────────────┴──────────────────────────────┘
 Search: ppt     [Enter] Review  [Backspace] Projects  [/] Search
```

- 标题优先用**第一条用户消息的短句**，去掉前导绝对路径（`对于"C:\…pptx"这个ppt，` → `需要新做三列技术路线页`）。
- 近重复标题折叠为最新一条 + `还有 4 条相似`。
- `/` 过滤只作用于当前项目；在项目列表则过滤项目名和路径。

### 4.3 审查页只回答一个问题

**「从哪一条用户消息开始冻成 TaskCase？」**

```text
┌─ Choose task start · CNCERT / 20260810汇报ppt ───────────────────────────────┐
│  将把下面高亮的用户消息写成不可变 TaskCase。还不会启动 Codex，也不会改源目录。 │
│                                                                              │
│  ❯ 1/3  对于这个 ppt…需要新做一页：三列技术路线（优势/劣势）                  │
│    2/3  请你给出修改后的这几页的 ppt                                         │
│    3/3  你自己截图看看，现在整个页面都不对了                                 │
│                                                                              │
│  冻结内容（当前选中）                                                        │
│    对于"…重点研发计划中期报告-0811.pptx"这个ppt，现在需要做的修改如下：…     │
│                                                                              │
│  会话结局（参考，不会写入 TaskCase 正文）  [d] 展开                          │
│    已重排 6 页修改稿，建议用 PowerPoint 复制/插入替换原页。                  │
└──────────────────────────────────────────────────────────────────────────────┘
 [Enter] Freeze this message  [↑↓] Choose start  [t] Privacy  [Esc] Back to list
```

元数据降级到一行：`session · 今天 15:19 · u3 a4 t60`。jsonl 路径放进 `?` 或 Preview，不要占两行。32 行必须能同时看到：三条候选、当前冻结预览、Enter 含义。Final 默认一行，`d` 展开。

选 2、选 3 时，**只有「冻结内容」块跟着变**。这才能让 ↑↓ 有反馈。

### 4.4 发现层（否则搜索也只是在 50 条里搜）

| 现在 | 改为 |
|---|---|
| 枚举全部 rollout，全部 `inspect`，再 `slice(50)` | 按文件 mtime 取最近 N 条 **或** 先按目录聚合成项目，每个项目取最近 K 条 |
| 打开 `/intake` 可能扫 3.5 GB | 列表只读小摘要；点进项目或审查才 parse 单文件 |
| 硬上限 50，更早会话不可达 | 搜索/项目钻取不受这 50 限制；全盘 FTS 以后再说 |

### 4.5 Home 选中态

冻结后右侧不要只显示 `case-c605…` / `Source codex`。改为：

```text
TaskCase   改中期报告 PPT · 从用户消息 1/3
Project    20260810汇报ppt
```

---

## 5. 实施顺序

1. **审查页改成「选起点」**（I1–I4、I6）。不改发现，立刻能看懂你这张截图。保留测试字符串 `Task input N/M:` 可以缩到一行 hint，或只在 message 槽出现。
2. **列表按 `cwd` 分组 + 其他**（L1）。显示名用目录 basename。
3. **intake 内 live search**（L3），学 `/resume`：可打印字符进查询，Esc 清空。过滤 summary / cwd / id。
4. **发现改为 mtime + 每项目限额**（L2），停止全量 parse。
5. **行不再被信号列撑破**（L4）：信号列固定宽度，摘要 `truncateFit`，禁止 panel 再把一行折成两行。
6. **Home 展示项目短名 + 任务短句**（H1）。
7. 确认页把 Candidate effort 和 Harness 模型分开写清楚（P2）。

明确不做：新 slash 命令、会话聊天、给会话打分、为了搜索把密钥或 prompt 全文建云端索引、在走查里对这条 PPT 会话按确认页 Enter。

---

## 6. 用这条会话验收

做完后应用同一 JSONL 再跑 `scripts/tui-intake-walkthrough.mjs`：

- 项目列表里能直接看到 `20260810汇报ppt`（或 CNCERT 短名），而不是 50 条时间线。
- 搜索 `ppt` / `CNCERT` / `中期报告` 能落到这条。
- 审查页一眼能读完三条用户消息；选 2 时预览变成「请你给出修改后的这几页的ppt」。
- 32 行仍能看到 Enter 的含义。
- 冻结后 Home 能看出这是 PPT 项目，而不是 `case-` 哈希。

---

## 7. 第二轮走查（已落地）

同一 JSONL 重跑 `node scripts/tui-intake-walkthrough.mjs`（16 帧，确认页未按 Enter）。`npm run check`：**86/86**。

| 验收项 | 结果 |
|---|---|
| 项目列表看到 `20260810汇报ppt` | 第二行，56 个项目 / 150 条最近会话 |
| 搜索 UUID / `ppt` / `CNCERT` | 收成 1 个项目 |
| 三条用户消息 + 选 2 预览变化 | `Freeze this message` 变成「请你给出修改后的这几页的ppt」 |
| 24 行仍能看到 Enter 含义 | `Nothing is written until you press Enter.` 仍在 |
| 冻结后 Home | `Project 20260810汇报ppt`，任务短句，不再是 `Source: codex` |

§5 的 1–7 均已落地。发现层按 mtime 取最近 150 条并只做摘要计数，不再全量 inspect 1269 个 jsonl。

刻意未做：全盘 FTS、近重复会话折叠、对这条 PPT 按确认页 Enter。搜索范围是已发现的 150 条，不是本机全部历史。
