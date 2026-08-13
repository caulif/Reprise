# Reprise TUI 设计稿

> 目标：把当前"能用但粗糙"的手写字符串界面，升级为一个成熟、好看、且严格贴合 Reprise 产品定位（local-first、重放与检视、四命令闭环）的终端工作台。
>
> 范围：`src/tui/`、`src/cli/main.ts` 的 TUI 装配点。不改变产品边界，不新增工作流。

---

## 0. 结论摘要

当前 TUI 的问题**不在功能，而在渲染层与信息架构**：功能闭环（`/config → /intake → /run → /history`）是完整且正确的，但呈现层是一套硬编码 76 列、无高度感知、无颜色、无滚动的手写字符串拼接，并且存在 3 个已实测确认的渲染缺陷。同时项目依赖的 `@earendil-works/pi-tui@0.84.1` 提供了完整的 flex 布局、滚动视图、浮层、选择列表和 ANSI/宽字符工具链，**目前一个都没有用上**。

本设计稿提出：

1. **修 3 个实测缺陷**（面板顶边框少 1 列、CJK 文本撑破面板、单条事件可产生 65 行刷屏）；
2. **建立设计系统**：断点、字形集、语义色板、面板/徽章/键位提示原语，替换掉现在的"先画框再用正则拆框"的反向 hack；
3. **重做信息架构**：Home 增加就绪度指示、运行页改为"状态轨 + 主从双栏"、结果页补上方案 B 要求的单次运行声明；
4. **分阶段接入 pi-tui 布局引擎**，获得真实滚动、鼠标滚轮、浮层帮助；
5. **拆分 God object**，把业务规则移出渲染模块。

每一阶段都标注了对现有测试的精确影响。**阶段一零测试改动。**

---

## 1. 现状盘点

### 1.1 模块地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/tui/codex-intake.ts` | 803 | 页面状态机 + 键盘路由 + 异步 I/O + 渲染调度 + 内容组装 |
| `src/tui/workbench-render.ts` | 376 | 纯渲染函数 + 配置草稿转换 + 会话资格判定 |
| `src/tui/timeline.ts` | 134 | 事件投影为操作员可读条目 |
| `src/tui/local-history.ts` | 67 | 只读本地 case/experiment |

### 1.2 渲染管线

```
CodexIntakeTui.#content()   →  一个巨型 string（含 \n）
        ↓
ResponsiveDocument.render(width)
        ↓  width < 32   → "Resize to at least 32 columns"
        ↓  width < 78   → compactNarrowLayout()：用正则把刚画好的框线拆掉
        ↓
    split('\n') → wrapTextWithAnsi(line, width)
        ↓
    tui.addChild(document)   ← 唯一一个子组件，不用任何布局能力
```

### 1.3 页面状态机

`loading → home → {config, sessions → inspection, history → history-detail, source → preflight → confirm → running → result} / error`

13 个 page，全部由 `#page` 字符串字段驱动，键盘路由在 `handleInput` 里用 13 个 `if` 顺序分发。

---

## 2. 问题诊断

### 2.1 P0 — 已实测确认的渲染缺陷

#### (a) 每个面板的顶边框都比底边框短 1 列

```342:345:src/tui/workbench-render.ts
function frame(title: string, lines: readonly string[]): string {
  const width = 76;
  const heading = `─${title}`;
  const top = `┌${heading}${'─'.repeat(Math.max(0, width - heading.length - 1))}┐`;
```

`width - heading.length - 1` 少减了一个 1。实测：`title=' Review session '` 时顶边框可见宽度 **77**，而正文行与底边框都是 **78**。这意味着**当前每一个面板的右上角都是错位的**。

正确写法是 `width - heading.length`。

#### (b) CJK 文本撑破面板（对本项目是真实场景）

`frame()` 用 `line.padEnd(width)` 补齐，`padEnd` 数的是 UTF-16 码元；而终端把中日韩字符渲染成 2 列宽。

实测（`Task 修复这个回归缺陷并验证测试全部通过`）：

| 行 | `.length` | `visibleWidth` |
|---|---|---|
| 顶边框 | 77 | 77 |
| **含 CJK 的正文行** | **78** | **95** |
| 底边框 | 78 | 78 |

该行可见宽度 95 > 视口 78，随后被 `wrapTextWithAnsi` 折成 2 行，面板彻底散架。

Codex 历史会话的任务文本、`summary`、`finalMessage` 完全可能是中文——**这是用户可见的必现 bug，不是理论风险**。

#### (c) 单条事件可产生 65 行，直接刷屏

```212:216:src/tui/workbench-render.ts
  return frame(` Timeline · Filter: ${filter} ${following ? '· live' : '· browsing'} `, visible.flatMap((entry, index) => {
    const marker = start + index === current ? '❯' : ' ';
    const head = ` ${marker} ${entry.occurredAt} · ${entry.source} · ${entry.title}`;
    return entry.detail ? [head, `     Detail  ${entry.detail}`] : [head];
  }));
```

`entry.detail` 是完整的 Agent 输出。`frame` 内部的 `wrapLine` 先把 `\n` 全替换成空格，再按 76 字符**硬切**：

- 一条 200 行的 agent message → **65 个渲染行**（实测）；
- 原文的换行结构全部丢失；
- 硬切不看词边界，单词被从中间劈开。

时间线窗口只有 21 条，其中一条就能占满并挤爆整屏。

### 2.2 P1 — 布局与响应式

| 问题 | 说明 |
|---|---|
| **宽度硬编码 76** | `divider()` 与 `frame()` 都写死 76。240 列的终端上，右侧 164 列是死区；100 列终端同样浪费。 |
| **完全没有高度感知** | 时间线窗口写死 `slice(start, start + 21)`。终端 24 行时溢出，60 行时空一半。`Component.render(width)` 不给高度，但 `tui.terminal.rows` 一直可读，从未使用。 |
| **窄屏是"反向 hack"** | `compactNarrowLayout` 先让 `frame()` 画出 Unicode 框，再用 6 个正则把框线拆掉、把 `❯●✓·…` 逐个替换回 ASCII。任何新符号都会漏网；任何正文里恰好出现的 `─` 都会被误伤。正确做法是**渲染前选字形集**，而不是渲染后做字符串手术。 |
| **换行不感知 ANSI/词边界** | 自写的 `wrapLine` 硬切；而依赖里就有 ANSI 安全、词边界安全的 `wrapTextWithAnsi`。 |
| **没有滚动** | 长文本一律靠 `compact(text, 300)` 截断丢弃。inspection 的 `finalMessage` 超过 300 字符就永久看不到。 |

### 2.3 P1 — 视觉与信息架构

| 问题 | 说明 |
|---|---|
| **零颜色** | 全界面单色。`TimelineEntry.level: 'warning' \| 'error'` 在 `timeline.ts` 被认真计算出来，**没有任何渲染代码读取它**——这是渲染层缺少严重度概念的直接证据。 |
| **Home 无就绪度** | 用户输入 `/run` 之后才被告知"没有 TaskCase"。命令是否可用应该**在输入前**就可见。这是当前最大的可用性缺口。 |
| **运行页缺状态感** | `run.state_changed` 只是时间线里一行文字。运行状态机（`created → preparing → launching → awaiting_target ⇄ awaiting_controller → finalizing → finished`）有明确阶段，却没有任何进度呈现；也没有已用时长、turn 计数。 |
| **结果页缺方案 B 声明** | `FIRST-PRINCIPLES-REVIEW.md` 要求固定标注"单次运行，结果受随机性影响"。报告里有，**TUI 结果页没有**。 |
| **头部对齐随机** | `header` 用 `' '.repeat(2)` 拼接，模型摘要的横向位置随 cwd 长度漂移。 |
| **键位提示不分层** | 底部一次性列出全部键位，长且噪声大；没有 `?` 全量键位表。 |
| **配置页无脏标记** | 改了字段但没按 `s`，界面上没有任何"未保存"提示。 |
| **无效值只说"隐藏"** | `[invalid reference hidden]` / `[invalid URL hidden]` 不告诉用户**哪里**不合法。 |

### 2.4 P2 — 工程结构

| 问题 | 说明 |
|---|---|
| **God object** | `CodexIntakeTui` 803 行，5 类职责耦合；`#content()` 是一串 13 个 `if` 返回模板字符串。 |
| **业务规则在渲染模块** | `configForDraft` / `draftForConfig` / `isEligible` 位于 `workbench-render.ts`。 |
| **异步无 generation 保护** | `void this.#loadSessions()` 等即发即忘。用户按 Esc 回 Home 后，迟到的 loader 仍会把 `#page` 覆写回去。连续两次 `/intake` 也会互相覆盖。 |
| **列表逻辑重复 4 份** | sessions / history / config / timeline 各自手写 `❯` 光标、索引 clamp、窗口计算；依赖里有 `SelectList`。 |

### 2.5 已经修好的历史问题（勿重复处理）

审阅文档里的以下条目在当前代码中**已经解决**，不要再按旧文档去改：

- `REVIEW-ROUND-3.md` 的 P0「timeline 读错 payload 形状」：`controllerEntries` 已读 `payload.value`，`controller.done` 已读 `payload.reason`（`src/tui/timeline.ts:53,79`）。
- `OPTIMIZATION-REVIEW.md` 的「`#loadSessions` 无 try/catch」：已有（`src/tui/codex-intake.ts:523-533`）。
- `OPTIMIZATION-REVIEW.md` 的「`#runtimeDetail` 死状态」：该字段已不存在。

---

## 3. 设计原则

从 `README.md` / `FIRST-PRINCIPLES-REVIEW.md` / `OPTIMIZATION-REVIEW.md` 提炼，作为本设计稿的硬约束：

1. **Home-first 的 Benchmark 工作台，不是 Coding Agent**。不新增 slash 命令，不做聊天流。
2. **同意阶梯不可压缩**：本地只读 → 显式 freeze → 显式源目录 → preflight → 明确费用确认 → 仅 `[t]` 触发网络。视觉上要**强化**这个阶梯，而不是让它更快跳过。
3. **不用倾向性语言**。无 better/worse/winner/score/ranking。结果页固定声明单次运行。
4. **密钥永不落盘、永不渲染**。只显示 `env:NAME` 引用。
5. **local-first**：不引数据库，不引新运行时依赖。颜色自己用 SGR 实现，**不引入 chalk**（当前依赖树中没有任何颜色库，保持零新增依赖）。
6. **Windows 11 优先**：色板限定 16 色基础 ANSI，保证 conhost / Windows Terminal 一致。
7. **不为拆而拆**：模块拆分只在本次实质修改覆盖的范围内进行。
8. **不做**：实时人工介入、多候选对比 UI、打分排名、交互式报告浏览器、文件快照 UI。

---

## 4. 设计系统

### 4.1 断点（density）

| 名称 | 宽度 | 行为 |
|---|---|---|
| `minimum` | `< 32` | 只显示 "Resize to at least 32 columns."（保持现状） |
| `compact` | `32 – 77` | ASCII 字形集，无边框，单栏，`[ Title ]` 段标题 |
| `regular` | `78 – 109` | Unicode 面板，单栏，**面板宽度 = 视口宽度**（不再是 76） |
| `wide` | `>= 110` | Unicode 面板，关键页面双栏（Home、Intake、Running） |

> 断点值 78 与现有测试对齐：60 列落在 `compact`（断言"无框线字符"），120 列落在 `wide`（断言 `┌─ Welcome / Recent runs`）。双栏只改变面板宽度，不改变面板标题与边框字符，因此 120 列断言依然成立。

### 4.2 字形集（渲染前选择，不做事后替换）

```ts
// src/tui/theme.ts
export interface Glyphs {
  tl: string; tr: string; bl: string; br: string;   // 圆角
  h: string; v: string;                              // 边
  teeL: string; teeR: string;                        // 分隔行
  cursor: string; dot: string; ok: string;
  warn: string; err: string; ellipsis: string; arrow: string;
}

const UNICODE: Glyphs = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', teeL: '├', teeR: '┤',
  cursor: '❯', dot: '●', ok: '✓', warn: '⚠', err: '✗', ellipsis: '…', arrow: '→',
};

const ASCII: Glyphs = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', teeL: '+', teeR: '+',
  cursor: '>', dot: '*', ok: '+', warn: '!', err: 'x', ellipsis: '...', arrow: '->',
};
```

`compact` 模式下面板不画边框，直接输出 `[ Title ]` + 缩进正文——与现有测试断言 `[ Welcome / Recent runs ]` 一致，且天然不会出现任何被禁字符。

### 4.3 语义色板

只用 16 色基础 ANSI，保证 Windows 兼容。**能力可注入**：

```ts
export function colorSupported(env = process.env, isTty = process.stdout.isTTY): boolean {
  return Boolean(isTty) && !env.NO_COLOR && env.TERM !== 'dumb';
}
```

关闭时所有样式函数退化为恒等函数——**测试环境（非 TTY）自动无色，现有纯文本断言全部不受影响**。

| 语义 token | 用途 | SGR |
|---|---|---|
| `accent` | 选中行、光标、焦点面板标题 | `36;1` 亮青 |
| `muted` | 时间戳、路径、次要说明 | `2` dim |
| `strong` | 面板标题、字段名 | `1` bold |
| `harness` | HARNESS 来源徽章 | `34` 蓝 |
| `controller` | CONTROLLER 来源徽章 | `35` 品红 |
| `target` | TARGET 来源徽章 | `36` 青 |
| `ok` | 成功、就绪、`completed` | `32` 绿 |
| `warn` | 警告、未保存、`⚠` 级事件 | `33` 黄 |
| `danger` | 错误、`✗` 级事件、`failed` 终止 | `31` 红 |

这套 token 直接消费 `TimelineEntry.level`——**让现在这份死数据活起来**。

### 4.4 渲染原语（宽字符安全）

全部基于 pi-tui 已导出的 `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`，**不再手写宽度计算**：

```ts
// src/tui/widgets.ts —— 纯函数，输入 (theme, width, data)，输出 string[]

/** 宽字符与 ANSI 安全的补齐；替换 padEnd。 */
export function pad(text: string, width: number): string;

/** 面板。regular/wide 画边框，compact 输出 "[ Title ]" + 缩进。顶底边框等宽。 */
export function panel(t: Theme, title: string, body: readonly string[], width: number): string[];

/** 面板内分隔行 ├────┤ */
export function separator(t: Theme, width: number): string;

/** 左右两端对齐的一行（头部用）。 */
export function justify(t: Theme, left: string, right: string, width: number): string;

/** 状态徽章：● API ready / ○ No TaskCase */
export function pill(t: Theme, label: string, state: 'ok' | 'warn' | 'off'): string;

/** 键位提示条：[Enter] Run  [Tab] Complete  [?] Keys */
export function keyHints(t: Theme, hints: readonly [string, string][], width: number): string;

/** 定宽列表格，每列用 truncateToWidth 截断。 */
export function table(t: Theme, rows: readonly Row[], columns: readonly Column[], width: number): string[];

/** 运行状态轨。 */
export function stateRail(t: Theme, current: CandidateRunState, width: number): string[];
```

`panel` 的正文换行改用 `wrapTextWithAnsi(line, innerWidth)`：词边界安全、ANSI 安全，并且**保留 `\n` 结构**（对每个物理行分别换行，而不是把 `\n` 拍平成空格）。这一项同时修掉 §2.1(b) 和 §2.1(c) 的换行部分。

---

## 5. 布局骨架

所有页面共用三段式：

```
┌ Header    2 行，固定 ── 品牌 · cwd · 模型 · 右对齐状态徽章 + 分隔线
│
├ Body      弹性，占满剩余高度 ── 页面内容；超出部分滚动
│
├ Message   1–2 行 ── 当前状态消息（错误用 danger 色）
└ Footer    2 行，固定 ── 分隔线 + 上下文键位提示
```

Body 的高度 = `terminal.rows - headerRows - messageRows - footerRows`。

**高度未知时（测试的 mock TUI、`preview()`）退化为无限高**，即不裁剪、不滚动、全量输出。这个退化行为很重要：它让现有测试中 `document.render(120)` 的全文断言（例如 `PUBLIC_DETAIL_END`）在阶段一继续成立。

---

## 6. 逐屏设计稿

以下线框按 **120 列（wide）** 绘制。

### 6.1 Home

```
Reprise v0.1.0   ~\Documents\model-test\Reprise                 gpt-5.6-terra · medium   ● API ready  ○ No TaskCase
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

┌─ Welcome / Recent runs ─────────────────────────────┐  ┌─ Current workspace ──────────────────────────────────┐
│                                                     │  │                                                      │
│   /config    Configure the API connection        ✓  │  │   TaskCase   none selected                           │
│   /intake    Import a Codex historical session      │  │   Source     —                                       │
│   /run       Run the current TaskCase       needs   │  │                                                      │
│              a TaskCase                             │  │   Recent     no local experiments                    │
│   /history   Browse local TaskCases and runs        │  │                                                      │
│                                                     │  │                                                      │
└─────────────────────────────────────────────────────┘  └──────────────────────────────────────────────────────┘

  Welcome back. Use /help to see the available local workflows.

  ❯ /co▌
    ┌─ Commands ──────────────────────────────────────┐
    │ ❯ /config    Configure the API connection       │
    │                                                 │
    └─────────────────────────────────────────────────┘

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 [Enter] Run command   [Tab] Complete   [?] Keys   [Ctrl+C] Exit
```

**关键改动**

- **就绪度指示**（本次最重要的可用性改进）：每条命令右侧显示当前是否可执行。`/config` 已配置显示 `✓`；`/run` 缺前置条件时显示 `needs a TaskCase` / `needs API config`，用 `warn` 色。用户不必再"试了才知道"。
- 头部状态徽章右对齐（用 `visibleWidth` 计算），不再随 cwd 长度漂移。
- 补全建议从裸列表升级为**紧贴输入行的浮层面板**，选中项高亮。
- 输入行有可见光标 `▌`。

### 6.2 `/config`

```
Reprise v0.1.0   ~\Documents\model-test\Reprise                 gpt-5.6-terra · medium   ● API ready  ○ No TaskCase
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

┌─ Harness API ────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                              │
│   ❯ provider type        openai-compatible                                            [Enter] toggles        │
│     provider label       private-gateway                                                                     │
│     base URL             https://api.example.test/v1                                                    ✓    │
│     model                model-private                                                                       │
│     effort               medium                                                       [Enter] cycles         │
│     API key reference    env:REPRISE_PRIVATE_KEY                                                        ✓    │
│                                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   ● Unsaved draft                                                                                            │
│   Keys stay in your environment. Reprise saves only env:NAME or ${NAME}.                                     │
│   Configuration file: .reprise\harness-model.json                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Edit an in-memory Harness configuration. Save never sends a request; connection testing is explicit.

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 [↑↓] Select  [Enter] Change  [s] Save locally  [t] Test connection  [Esc] Home
```

**关键改动**

- 每行右侧有**校验徽章**：`✓` 合法、`⚠ not an https URL` / `⚠ expected env:NAME`。取代现在只说"已隐藏"却不说原因的做法。
- `● Unsaved draft` 脏标记（`warn` 色），保存后变 `✓ Saved locally`（`ok` 色）。
- 行内提示可切换字段的操作方式（toggle / cycle / 文本编辑），降低"按 Enter 会发生什么"的不确定性。
- `[t]` 测试期间用 pi-tui `Loader` 显示转轮，结果以徽章呈现；**错误消息继续走 `safeConfigError` 脱敏**。

### 6.3 `/intake` 会话列表

```
┌─ Codex sessions · 12 found · filter: eligible ───────────────────────────┬─ Preview ─────────────────────────┐
│                                                                          │                                   │
│   2026-08-11 09:12   Fix the regression in the parser        u2 a3 t7    │  Session   session-2              │
│ ❯ 2026-08-10 21:40   修复中文路径下的构建失败                 u1 a2 t4    │  Started   2026-08-10 21:40       │
│   2026-08-10 18:03   Add retry to the upload path            u4 a6 t19   │  Workspace C:\src\reprise         │
│   2026-08-09 11:55   Investigate flaky timeout               u2 a2 t3    │  Runtime   codex 0.1.0            │
│                                                                          │                                   │
│                                                                          │  Task                             │
│                                                                          │    修复中文路径下的构建失败，     │
│                                                                          │    并补一个回归测试。             │
└──────────────────────────────────────────────────────────────────────────┴───────────────────────────────────┘
```

**关键改动**

- 从"每会话 2 行"改为**单行表格**，列用 `truncateToWidth` 独立截断，密度翻倍。
- 右侧预览面板：不进入 inspection 就能看到工作区与任务摘要，减少一次往返。
- 标题带计数与筛选态，`f` 的效果可见（现在筛选状态只在消息行里）。
- 中文会话标题正确对齐（依赖 §4.4 的宽字符安全 `pad`）。

### 6.4 Inspection（freeze 前）

```
┌─ Review session ─────────────────────────────────────────────────────────────────────────────────────────────┐
│   Session    session-2                          Started    2026-08-10 21:40                                  │
│   Workspace  C:\src\reprise                     Runtime    codex 0.1.0 · gpt-5.6-luna                        │
│   Source     ~\.codex\sessions\rollout-….jsonl                                                               │
│   Signals    users 2 · assistant 3 · tools 7 · completed turns 1                                             │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Task input 2/2: Verify the regression.                                              [↑↓] choose start      │
│                                                                                                              │
│     1  Fix the bug.                                                                                          │
│   ❯ 2  Verify the regression.                                                                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Final      Fixed it and the suite passes.                                                                  │
│   Privacy    model text blocked · binary blocked · literal redactions none                  [t] toggles       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Review the session details and privacy policy before writing a TaskCase.
  Nothing is written until you press Enter.

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 [Enter] Freeze immutable TaskCase   [↑↓] Select task start   [t] Toggle model text   [Esc] Home
```

**关键改动**

- 元数据改**双列键值**，纵向压缩近一半，正文区留给真正重要的"任务起点选择"。
- 任务起点从"一行里显示第 N 条"升级为**可见列表 + 高亮**，用户能看到全部候选起点而不是只看当前一条。保留 `Task input N/M: …` 文案（测试契约）。
- 显式提示 "Nothing is written until you press Enter"，强化同意阶梯。
- 长 `Final` 文本改为**按可用高度裁剪 + 可滚动**，不再用 `compact(…, 300)` 永久丢弃。

### 6.5 `/run` 三步同意阶梯

三个页面（source / preflight / confirm）保留，但统一加**步骤指示器**，让用户知道自己在阶梯的哪一级、还剩几级：

```
  Step 1 of 3 ─ Source root      ●──○──○
  Step 2 of 3 ─ Preflight        ✓──●──○
  Step 3 of 3 ─ Confirm run      ✓──✓──●
```

Confirm 页强化费用与安全声明：

```
┌─ Start isolated Codex Candidate? ────────────────────────────────────────────────────────────────────────────┐
│                                                                                                              │
│   Candidate        gpt-5.6-luna · high reasoning                                                             │
│   Harness agents   persisted Pi model · Controller, Comparison                                               │
│   Fidelity         observational                                                                             │
│                                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   ⚠  This starts a Codex process and may call your configured provider, which can cost money.               │
│   ✓  Your original source, the historical session, and global Codex config are left unchanged.               │
│   ✓  The replay starts from the current state of C:\explicit-source, not the historical state.               │
│                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

费用警示用 `warn` 色 + `⚠`，安全保证用 `ok` 色 + `✓`。这是**唯一**一处刻意用颜色制造停顿的地方。

> 注意：这里不恢复被明确否决的 `[o]` observational 确认仪式——仍然是单次 `[Enter]` + 固定 limitation 文案，只是把文案做成有视觉层级的清单。

### 6.6 Running（核心页面，改动最大）

```
Reprise v0.1.0   Run · case-4f2a…                     elapsed 02:41   turn 2/4   calls 2/3           ● running
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  ✓ created  →  ✓ preparing  →  ✓ launching  →  ● awaiting_target ⇄ awaiting_controller  →  · finalizing  →  · finished

┌─ Timeline · ALL · live ──────────────────────────────────┬─ Detail ─────────────────────────────────────────────┐
│   00:10:00   HARNESS      Run created                    │  CONTROLLER · 00:10:01 · seq 2                       │
│   00:10:00   HARNESS      State: created → preparing     │  ──────────────────────────────────────────────────  │
│   00:10:01   CONTROLLER   Decision: SEND                 │  Decision: SEND                                      │
│ ❯ 00:10:01   CONTROLLER   Input to Target                │                                                      │
│   00:10:02   TARGET       Command completed              │  Rationale                                           │
│   00:10:05   TARGET       Visible response               │    One check remains before the task is complete.    │
│   00:10:06   TARGET       Runtime warning            ⚠   │                                                      │
│   00:10:07   HARNESS      Turn settled: completed        │  Message to Target                                   │
│                                                          │    Run the focused test.                             │
│                                                          │                                                      │
│                                                     8/24 │                                              1 of 12 │
└──────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┘

  Candidate is running only in an isolated workspace.

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 [↑↓] Select  [PgUp/PgDn] Page  [l] Follow latest  [f] Filter ALL▸TARGET  [Ctrl+C] Request cancellation  [?] Keys
```

**关键改动**

1. **状态轨**：把 `run.state_changed` 从"时间线里的一行文字"提升为持续可见的进度指示。已完成阶段 `✓`（`muted`），当前阶段 `●`（`accent`），未到达 `·`（`muted`）。`awaiting_target ⇄ awaiting_controller` 的循环显式画出来，配合 `turn 2/4`。
2. **主从双栏**：左侧一行一事件（时间 / 来源徽章 / 标题 / 严重度），右侧独立滚动的详情面板。**这是 §2.1(c) 刷屏问题的结构性解法**——200 行的 agent message 只在右侧详情里，且带滚动，永远不会挤爆左侧列表。
3. **来源着色**：HARNESS 蓝 / CONTROLLER 品红 / TARGET 青；`level` 决定行尾 `⚠`/`✗` 徽章与着色。终于消费了那份死数据。
4. **运行度量**：已用时长、turn 计数、模型调用计数 —— 全部来自 `RunPolicy` 与已有事件，不新增数据源。
5. **滚动位置指示** `8/24`、`1 of 12`，配合 `live` / `browsing` 状态。
6. `[f]` 提示直接显示**下一个**筛选值（`ALL▸TARGET`），消除"按下去才知道"的盲操作。
7. 取消中：状态徽章变 `● cancelling`（`warn`），并显示"waiting for runtime stop and workspace cleanup"。

窄屏（`compact` / `regular`）时详情面板折叠到列表下方，`[d]` 切换展开。

### 6.7 Result

```
┌─ Run result ─ completed ─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                              │
│   ✓ completed                                                                                                │
│     completed.controller_satisfied                                                                           │
│                                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Run          run-1 · 3m 12s                       Cleanup      complete                                    │
│   Controller   done                                 Comparison   completed                                   │
│   Fidelity     observational                        Limitations  fingerprint differs                         │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Report       C:\…\experiments\experiment-8c1d\report.html                                                  │
│   Trace        C:\…\experiments\experiment-8c1d\runs\run-1\                                                  │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Single run. Results vary between runs. Reprise records facts for inspection, not rankings.                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 [Enter] Home   [b] Home
```

**关键改动**

- 结果横幅按终止类型着色：`completed` 绿、`cancelled` 黄、`failed`/`timeout` 红。**颜色描述的是"运行是否正常结束"，不是"模型好不好"**——不违反方案 B。
- 补上**方案 B 要求的固定声明**（当前 TUI 缺失）。
- 证据路径独立成区，便于复制。
- 继续遵守测试注释的要求：所有字段都按可选处理，缺失时显示 `—`，不假设 workflow 结果一定完整。

### 6.8 帮助浮层（`?`）

用 pi-tui `showOverlay` 实现，居中，`Esc` 关闭：

```
        ┌─ Keys ───────────────────────────────────────────────┐
        │                                                      │
        │   Commands: /config, /intake, /run, /history         │
        │                                                      │
        │   Global      Esc      Back to Home                  │
        │               Ctrl+C   Cancel run, or exit           │
        │               ?        This help                     │
        │                                                      │
        │   Lists       ↑ ↓      Select      Enter   Open      │
        │               Tab      Switch tab                    │
        │                                                      │
        │   Running     f        Cycle filter                  │
        │               l / End  Follow latest                 │
        │               PgUp/Dn  Page                          │
        │                                                      │
        │   Config      s        Save locally (no network)     │
        │               t        Test connection (network)     │
        │                                                      │
        └──────────────────────────────────────────────────────┘
```

浮层正文包含 `Commands: /config, /intake, /run, /history` 原文，保持现有测试断言成立。

### 6.9 Compact 回退（60 列）

```
Reprise v0.1.0   ~\model-test\Reprise
gpt-5.6-terra - medium        * API ready   o No TaskCase
------------------------------------------------------------

[ Welcome / Recent runs ]
   /config    Configure the API connection            +
   /intake    Import a Codex historical session
   /run       Run the current TaskCase       needs a TaskCase
   /history   Browse local TaskCases and runs

[ Current workspace ]
   TaskCase   none selected
   Recent     no local experiments

  Welcome back. Use /help to see the available local workflows.

  > Enter a task or / command...

------------------------------------------------------------
 [Enter] Run  [Tab] Complete  [?] Keys  [Ctrl+C] Exit
```

不含 `┌ ┐ └ ┘ │ ─ ❯ ● ✓ …` 中任何一个字符，满足现有断言；并且是**直接用 ASCII 字形集渲染出来的**，不是事后正则替换的产物。

---

## 7. 代码结构

### 7.1 目标文件布局

```
src/tui/
  theme.ts            Glyphs / 色板 / density 解析 / 能力探测      ~120 行
  widgets.ts          pad / panel / separator / justify / pill /
                      keyHints / table / stateRail                 ~220 行
  viewport.ts         Viewport { width, height? } 与三段式高度分配  ~60 行
  pages/
    home.ts           renderHome                                   ~90 行
    config.ts         renderConfig                                 ~110 行
    intake.ts         renderSessions / renderInspection            ~140 行
    run.ts            renderSource / Preflight / Confirm /
                      renderRunning（状态轨 + 主从双栏）           ~200 行
    history.ts        renderHistory / renderHistoryDetail          ~90 行
    result.ts         renderResult                                 ~70 行
  workbench.ts        根 Component：header + body + message + footer ~120 行
  controller.ts       页面状态机 + 键盘路由 + generation 保护       ~320 行
  timeline.ts         保持不变（已正确）
  local-history.ts    保持不变
  codex-intake.ts     薄门面，保留 start/run/preview/handleInput    ~60 行
```

`codex-intake.ts` 保留为门面，因为 `src/cli/main.ts` 与 `test/codex-intake.test.ts` 都依赖 `CodexIntakeTui` 这个类名与它的公开方法。**公开 API 一个都不动。**

### 7.2 需要移出渲染层的业务规则

| 函数 | 现位置 | 目标位置 |
|---|---|---|
| `draftForConfig` / `configForDraft` / `setConfigField` / `configFieldValue` | `workbench-render.ts` | `src/infrastructure/harness-model-config.ts` |
| `isEligible` | `workbench-render.ts` | `src/products/codex/sessions.ts` |
| `safeConfigError` / `safeBaseUrlDisplay` | `workbench-render.ts` | `src/infrastructure/harness-model-config.ts`（脱敏是安全边界，不是排版） |

### 7.3 异步 generation 保护

修掉 §2.4 的"迟到 loader 覆写页面"竞态：

```ts
// controller.ts
#generation = 0;

#beginNavigation(): number {
  this.#generation += 1;
  return this.#generation;
}

async #loadSessions(): Promise<void> {
  const token = this.#beginNavigation();
  try {
    const sessions = await discoverCodexSessions(this.#sessionsRoot);
    if (token !== this.#generation) return;   // 用户已离开，安静丢弃
    this.#sessions = sessions;
    this.#page = 'sessions';
    // …
  } catch (error) {
    if (token !== this.#generation) return;
    this.#page = 'error';
    this.#message = errorMessage(error);
  }
  this.#render(true);
}
```

同样应用于 `#loadHistory` / `#inspect` / `#freeze` / `#loadPreflight` / `#openConfig`。

> `#startExperiment` **不加** generation 保护：实验一旦启动必须走完取消/清理，不能被导航静默丢弃。这是有意的例外。

### 7.4 高度感知的接入方式

`Component.render(width)` 不提供高度，但 `TUI.terminal.rows` 一直可读。根组件持有一个 viewport 取值器：

```ts
// workbench.ts
constructor(content: () => PageModel, viewport: () => { width?: number; height?: number }) {}

render(width: number): string[] {
  const height = this.#viewport().height;   // undefined ⇒ 不裁剪
  // …
}
```

生产环境传 `() => ({ height: tui.terminal.rows })`；测试的 mock TUI 没有 `terminal`，取值器返回 `{}`，走**无限高度**分支——全量输出，现有全文断言继续通过。

---

## 8. 与 pi-tui 的对接

### 8.1 现在用了什么

只用了 3 个：`Component`、`wrapTextWithAnsi`、`matchesKey`，外加 `TuiAltScreen` + `ProcessTerminal`。

### 8.2 应该用什么

| 能力 | pi-tui 导出 | 用途 | 阶段 |
|---|---|---|---|
| 宽字符宽度 | `visibleWidth` | 修 CJK 对齐（§2.1b） | 1 |
| 列截断 | `truncateToWidth` | 表格列、单行摘要 | 1 |
| 安全换行 | `wrapTextWithAnsi` | 面板正文 | 1 |
| 弹性布局 | `VStack` / `HStack` + `StackEntryOptions{grow,basis,minSize}` | 三段式 + 双栏 | 2 |
| 滚动 | `ScrollView{follow:'end', primary, scrollbar:'auto'}` | 时间线跟随、详情滚动、鼠标滚轮 | 2 |
| 视口根 | `isViewportTUI` + `setLayoutRoot` | 启用上述布局引擎 | 2 |
| 浮层 | `showOverlay` / `OverlayHandle` | `?` 帮助、命令补全 | 3 |
| 选择列表 | `SelectList` + `SelectListTheme` | 替换 4 份重复的手写列表 | 3 |
| 模糊过滤 | `fuzzyFilter` | 会话列表搜索（可选） | 3 |
| 转轮 | `Loader` | `[t]` 连接测试、preflight 等待 | 3 |

### 8.3 关键技术约束

`VStack` / `HStack` / `ScrollView` 的弹性分配**只在 `TuiAltScreen.setLayoutRoot()` 下生效**——它们依赖未导出的内部布局引擎（`dist/layout.d.ts` 不在 `index.d.ts` 的导出列表中）通过 `updateLayout()` 注入视口高度。用 `addChild()` 挂载时，`ScrollView` 拿不到视口高度。

因此**阶段一必须继续用 `addChild` + 自有高度分配**（§7.4），阶段二才切换到 `setLayoutRoot`。这不是偷懒，是库的实际约束。

### 8.4 阶段二的测试适配

切到 `setLayoutRoot` 后，现有测试的 mock TUI（只有 6 个方法）不再能拿到渲染结果。适配方案：实现一个假 `Terminal`（该接口已从 `index.d.ts` 导出，只有 columns/rows/write/start/stop 等十余个方法），配真实 `TuiAltScreen`，再用已导出的 `stripTerminalSequences` 把写入的帧还原成纯文本：

```ts
// test/support/fake-terminal.ts
export function renderFrame(tui: TUI, term: FakeTerminal, rows = 30, cols = 120): string {
  term.resize(cols, rows);
  tui.renderNow(true);
  return stripTerminalSequences(term.drainWrites())
    .split('\n').map((line) => line.trimEnd()).join('\n');
}
```

这比现在的 mock **更接近真实**：现有测试从未真正走过高度分配与滚动路径。

---

## 9. 迁移路线

### 阶段 1 — 渲染层修复与设计系统（**零测试改动**）

1. 新建 `theme.ts`（字形集 + 色板 + density），删除 `compactNarrowLayout` 正则 hack。
2. 新建 `widgets.ts`，`panel` 修掉顶边框 off-by-one，`pad` 用 `visibleWidth` 修 CJK。
3. 面板宽度从硬编码 76 改为视口宽度。
4. 正文换行改用 `wrapTextWithAnsi`，保留 `\n` 结构。
5. 头部状态徽章右对齐；Home 加就绪度指示。
6. 时间线消费 `TimelineEntry.level`（着色 + `⚠`/`✗`）。
7. 结果页补方案 B 声明；配置页加脏标记与校验徽章。
8. 引入 `viewport.ts`，高度已知时裁剪 body、未知时全量输出。
9. `controller.ts` 加 generation 保护。
10. 业务规则移出 `workbench-render.ts`。

验证：`npm run check` 全绿，无需修改任何断言。

### 阶段 2 — 布局引擎（**需要新测试脚手架**）

11. 生产装配改 `setLayoutRoot(VStack[header, ScrollView(body), message, footer])`。
12. 时间线用 `ScrollView{follow:'end', primary:true}`，获得鼠标滚轮与滚动条。
13. 详情面板独立 `ScrollView`。
14. 新增 `test/support/fake-terminal.ts`（§8.4）。

### 阶段 3 — 交互精修

15. `?` 帮助浮层（`showOverlay`）。
16. 命令补全改浮层 + `SelectList` + `fuzzyFilter`。
17. 四处手写列表统一到 `SelectList`。
18. `[t]` 与 preflight 加 `Loader`。
19. `/run` 三步指示器；Running 页运行度量（elapsed / turn / calls）。
20. Intake 双栏预览。

---

## 10. 测试影响清单

### 阶段 1：无改动

| 断言 | 位置 | 为何仍然成立 |
|---|---|---|
| 60 列无 `[┌┐└┘│─❯●✓…]` | `codex-intake.test.ts:22` | 60 落在 `compact`，直接用 ASCII 字形集 |
| `[ Welcome / Recent runs ]` | `:23` | compact 面板格式保持 |
| `^Reprise v0.1.0` | `:24` | 头部首行不变 |
| 31 列提示 | `:25` | `minimum` 分支不变 |
| `┌─ Welcome / Recent runs` | `:39` | 120 落在 `wide`，双栏只改宽度不改标题/边框 |
| `Enter a task or / command` | `:40` | 占位文案不变 |
| `Task input 1/2: …` | `:107,112` | 文案保留 |
| `Commands: /config, /intake, /run, /history` | `:158` | 消息行保留 |
| `Detail[\s\S]*PUBLIC_DETAIL_END` | `:275` | mock TUI 无 `terminal` ⇒ 高度未知 ⇒ 不裁剪，全量输出 |
| 连续 3 个事件只 render 1 次 | `:269` | 16ms 合并逻辑不动 |
| 保存的 JSON 无明文密钥 | `:359-364` | 脱敏逻辑仅换位置不换行为 |

### 阶段 2：需要精确修改 2 处

| 断言 | 现状 | 改为 |
|---|---|---|
| `codex-intake.test.ts:275` `Detail[\s\S]*PUBLIC_DETAIL_END` | 依赖"无限高度全量输出" | 真实视口下详情分页。改为：详情面板 `scrollToEnd()` 后断言包含 `PUBLIC_DETAIL_END`；同时新增断言"单条事件不得占据超过详情面板高度"——这正是本次要修的行为 |
| 全部 `document?.render(120)` | 依赖 `addChild` 捕获子组件 | 改用 `renderFrame(tui, terminal)`（§8.4） |

### 阶段 3：需要新增

- `?` 浮层：断言 `Commands: /config, /intake, /run, /history` 出现在浮层内容中。
- `widgets.test.ts`：`panel` 顶底边框等宽；CJK 行 `visibleWidth === width`；ASCII 字形集不含被禁字符。

新测试文件需注册到 `test/index.test.ts`。

---

## 11. 明确不做

严格遵守既有否决记录，本设计稿**不包含**：

- 新增 slash 命令 / 把 TUI 变成通用 Coding Agent；
- 无 slash 文本发给模型或修改工作区；
- 恢复每次运行的 `[o]` observational 确认仪式（Confirm 页仍是单次 `[Enter]`）；
- 打分、排名、宣布胜者的任何 UI；
- 实时人工干预 / 流式介入；
- 交互式 HTML 报告或内建 diff 查看器；
- 文件系统快照 / 容器复原 UI；
- 多候选对比布局；
- 为 timeline payload 引入 schema 抽象层；
- 引入 chalk 或任何新运行时依赖（颜色用内置 SGR 常量实现）；
- 启动时强制进入 `/config`。

---

## 附录 A：键位表（设计后）

| 场景 | 键 | 行为 |
|---|---|---|
| 全局 | `Esc` | 返回 Home / 丢弃字段编辑 |
| 全局 | `Ctrl+C` | 运行中：请求取消；其他：退出并恢复终端 |
| 全局 | `?` | 键位浮层 |
| Home | 文本 + `Enter` | 提交命令；非 slash 只给本地提示 |
| Home | `Tab` | 补全 slash 命令 |
| 列表 | `↑` `↓` | 选择 |
| 列表 | `Enter` | 打开 / 确认 |
| History | `Tab` | 切换 experiments / TaskCases |
| Sessions | `f` | 切换 eligible 筛选 |
| Inspection | `↑` `↓` | 选择任务起点 |
| Inspection | `t` | 切换 model text 共享 |
| Inspection | `Enter` | 冻结 TaskCase |
| Config | `↑` `↓` / `Enter` | 选择字段 / 切换或编辑 |
| Config | `s` / `t` | 本地保存（无网络） / 显式连接测试（有网络） |
| Config 编辑中 | `Enter` / `Ctrl+A` / `Esc` | 应用 / 清空 / 保留原值 |
| Running | `↑` `↓` `PgUp` `PgDn` | 浏览时间线 |
| Running | `l` / `End` | 跟随最新 |
| Running | `f` | 循环筛选 ALL → TARGET → CONTROLLER → HARNESS |
| Running | `d` | 窄屏下展开/收起详情 |

## 附录 B：颜色应用表

| 元素 | token |
|---|---|
| 面板标题 | `strong`；聚焦面板 `accent` |
| 选中行 | `accent` |
| 时间戳 / 路径 / 提示 | `muted` |
| 来源徽章 HARNESS / CONTROLLER / TARGET | `harness` / `controller` / `target` |
| `level: 'warning'` | `warn` + `⚠` |
| `level: 'error'` | `danger` + `✗` |
| 就绪 / 已保存 / `completed` | `ok` |
| 未保存草稿 / 校验失败 / `cancelled` | `warn` |
| 错误消息 / `failed` / `timeout` | `danger` |
| 费用警示 | `warn`（唯一刻意制造停顿处） |

## 附录 C：缺陷复现脚本

```bash
node -e "
const { visibleWidth } = require('./node_modules/@earendil-works/pi-tui/dist/index.js');
function wrapLine(l,w){const n=l.replaceAll('\n',' ');if(!n)return[''];const o=[];for(let i=0;i<n.length;i+=w)o.push(n.slice(i,i+w));return o;}
function frame(t,ls){const w=76,h='-'+t;const top='+'+h+'-'.repeat(Math.max(0,w-h.length-1))+'+';
  return [top,...ls.flatMap(l=>wrapLine(l,w)).map(l=>'|'+l.padEnd(w)+'|'),'+'+'-'.repeat(w)+'+'].join('\n');}
for (const line of frame(' Review session ',[' Task 修复这个回归缺陷并验证测试全部通过']).split('\n'))
  console.log('visibleWidth=' + visibleWidth(line));
console.log('rows for one 200-line message:',
  wrapLine('     Detail  '+Array.from({length:200},(_,i)=>'line '+i).join('\n'),76).length);
"
```

预期输出证实三个缺陷：顶边框 77 / CJK 正文 95 / 底边框 78，以及单条消息 65 行。
