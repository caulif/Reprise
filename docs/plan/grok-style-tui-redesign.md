# Reprise TUI 全面重构：借鉴 Grok Build 的会话画布

状态：专题计划，非当前阶段闸门
日期：2026-08-14
设计稿：[每面 HTML 线框](./grok-style-tui-mockups.html)（只展示本文信息架构，不另定验收条件）
权威性：不覆盖 [`product/tui.md`](../product/tui.md)、[`architecture/overview.md`](../architecture/overview.md) 或 [`development-plan.md`](../development-plan.md)
取代范围：取代「继续打磨 Running 页右侧 Detail」这条局部路线。此前工具卡片方向（`$` 命令、`⎿` 输出、`… +N lines`）作为卡片渲染语言保留，不再作为独立优化目标。
设计依据：

- [Grok Build 概览](https://docs.x.ai/build/overview)
- [Modes and Commands](https://docs.x.ai/build/modes-and-commands)
- [Keyboard Shortcuts](https://docs.x.ai/build/keyboard-shortcuts)
- [xai-org/grok-build](https://github.com/xai-org/grok-build) 中 `xai-grok-pager` 的 AppView / AgentView / scrollback / overlay 分层
- 当前实现：`src/tui/controller.ts`、`src/tui/workbench.ts`、`src/tui/timeline.ts`、`src/tui/pages/*`
- 产品约束：[`product/tui.md`](../product/tui.md)

## 1. 结论

Reprise 的 TUI 问题不在某一栏文案或某一帧截图，而在**整屏信息架构选错了隐喻**。

当前实现把一次实验画成**调试器**：13 个页面互相替换，Running 再拆成左列表 + 右 Detail。操作者在两个面板之间对同一条事实读两遍，窄终端还要再换一套布局。

Grok Build 把一次会话画成**可折叠的对话画布**：常驻 Scrollback + Prompt，设置/会话/扩展都是 overlay，详情就地展开，溢出才进全屏 viewer。侧栏（tasks / todos）默认关闭，不和主叙事抢宽度。

Reprise 应直接借这套壳，而不是继续在 Detail 里微调。产品身份不变：它仍是本地 Benchmark 工作台，不是会在当前仓库改代码的 coding agent。借的是**壳与信息层次**，不是 Grok 的工具、模式或品牌。

```text
不要再问：Detail 还缺什么字段？
要问：这条事实该不该出现在主画布上？默认折叠还是展开？溢出时去哪？
```

## 2. 借鉴对象与硬边界

### 2.1 借鉴谁

对象是 xAI 的 **Grok Build**（安装名 `grok`，源码 crate `xai-grok-pager`），不是 Grok 网页聊天，也不是 Cursor 里的模型选择器。

它的 TUI 可以概括成四句话：

1. 启动落在 Welcome，任何时候 `/home` 能回来。
2. 进入会话后只有两块常驻区域：Scrollback 和 Prompt。
3. 其余能力（settings、sessions、extensions、context、usage）是同一套 modal，用斜杠命令预选页签。
4. Scrollback 里每条记录可折叠；`Enter` 打开全屏 viewer；`Ctrl+G` / `Ctrl+T` 才打开可选侧栏。

### 2.2 借原则，不借功能清单

| 借 | 不借 |
|---|---|
| Scrollback + Prompt 两区模型 | 在当前工作区用自然语言改代码 |
| Welcome 作为可回的家 | Plan / Auto / Always-approve 作为产品模式 |
| Overlay 替换页面栈 | `/imagine`、`/fork`、marketplace、MCP 扩展商店 |
| 条目就地展开 + 全屏 viewer | 复制 Grok 快捷键全集（50+） |
| 按焦点/运行态变化的底栏 | 把 Reprise 变成通用 agent 会话 |
| 可选 Tasks pane，默认不占主画布 | 第二套 runtime、凭据库或 UI 框架 |
| Turn 分组与「Worked for …」收束 | 伪造 hidden reasoning 或 token |
| 密度模式（compact / fullscreen）只改留白 | 为窄终端发明另一套信息架构 |
| 命令面板 + 斜杠发现 | 自动发送实验或静默改全局配置 |
| Elm 式 Action → Effect，干掉巨型 page switch | 鼠标优先；键盘仍是第一输入 |

### 2.3 与既有产品规划的关系

[`product/tui.md`](../product/tui.md) 已经写过：「宽终端可以使用双栏，窄终端切换独立页面；**右侧入口不是架构约束**。」当前 Running 页把右侧 Detail 做成了默认架构，和产品文档相反。

上一轮 TUI 计划（Home first、命令优先）已经落地，但把「当前视图」实现成了页面替换；那份计划已执行完毕并移出版本控制，其产品边界现由 [`product/tui.md`](../product/tui.md) 承载。本次重构继续那条边界，改掉它留下的页面机。

## 3. Grok 抽出来的七条原则

下面每条都写成 Reprise 可执行的约束，而不是对 Grok 的功能介绍。

### 3.1 主画布是两色对话，不是事件河

成熟 agent TUI 把「用户说的」和「助手做的」分成两种颜色，工具跟在助手那一侧。Reprise 对照同样只画两色：

- 紫：发给 Agent 产品的话（历史题目或续问原文）
- 青：该产品窗口里已经能看见的东西（经 Pack 译成统一块）

准备进度、决策依据、Harness 心跳默认不进这条对话。

### 3.2 详情默认长在条目上

Grok：`h` / `l` 折叠当前条，`e` 切换，`E` 全开/全关，`Enter` 进 viewer。

Reprise 现状：列表只留标题，详情永远在另一栏，标题还重复一遍。应改为：

- 默认：一行摘要（谁 · 做了什么 · 结果）
- 展开：卡片正文（命令、输出预览、决策依据、投递状态）
- 溢出：`o` / `Enter` 打开只读 viewer，看 `original` / 报告 / trace

右侧 Detail 不再是 Running 的默认布局。宽终端若要并排，只能作为「选中条的固定预览」，且必须与展开态显示同一套卡片，禁止第二套字段。

### 3.3 页面是失败，Overlay 是默认

Grok 把 `/settings`、`/sessions`、`/context`、`/usage`、extensions 做成同一类 modal。用户不会离开会话画布去「设置页」，再找回来的路。

Reprise 今天有 13 个 `WorkbenchPage`。其中只有两种东西配得上「换面」：

- **Welcome**：还没有打开实验画布
- **Experiment**：正在看或正在跑一次实验

其余全部降为 overlay：

| 今日页面 | 重构后 |
|---|---|
| `home` | Welcome 面 |
| `running` / `result` | Experiment 面（终态仍在同一画布） |
| `config` | Settings overlay |
| `sessions` / `inspection` | Intake overlay |
| `history` / `history-detail` | History overlay |
| `source` / `preflight` / `confirm` | Run-setup overlay（单次确认，不是三步向导） |
| `error` | 画布内错误卡片，或阻塞 modal；不再是孤立页 |
| `loading` | Welcome 上的瞬时状态 |

`/run` 的 source → preflight → confirm 三步向导并进一个 overlay：缺 source 才显示路径框，preflight 事实和确认按钮在同一张卡片上。这与 [`product/tui.md`](../product/tui.md)「一次准备并开始」一致。

### 3.4 底栏只提示此刻能做的事

Grok 的 Shortcuts Bar 随焦点（prompt / scrollback）、是否在跑、选中条目类型变化。

Reprise 今天每页有一份静态 `*Hints()`。重构后底栏是函数：`hints(focus, runState, selectedKind)`。跑的时候不提示 Home 的 `Enter Run command`；选中命令卡片时才提示 `o` 打开全文。

### 3.5 并发工作进侧栏，不进主列表

Grok 用 `Ctrl+G` 打开 Tasks pane（后台命令、subagent），用 `Ctrl+T` 打开 todo pane。主 Scrollback 仍然讲故事。

Reprise 有四路并发角色：Recovery、Controller、Target、Comparison。它们的心跳、预算、当前工具应进可选 **Actors pane**，不要每条 `stage_changed` 都在主河上占一行。主河只留阶段切换、决策、投递、用户可见的 Target 动作和错误。

### 3.6 用对话块跳转，不用 seq 当导航

按「发给它」和「它的屏幕」两块跳，不按事件序号。顶栏最多写「第 2 轮」，不写 `target 2/4`。`sequence` 和原始时间戳属于 viewer / trace。

### 3.7 状态机按 Action 分发，不按页面分发

Grok pager 是 Elm 式：输入 → Action → dispatch → Effect。`AppView` 管 Welcome / 多会话 / 全局配置，`AgentView` 管一条会话的 prompt、scrollback、tool panes、modals。

Reprise 的 `controller.ts` 按 `#page === 'running' | 'config' | …` 分支。页面一拆，按键语义就复制一份。重构后只有：

```text
input → Action → AppModel.reduce → Effect
```

overlay 打开时，未声明的按键不落到画布；画布的 follow / 选择状态在 overlay 底下保持，关掉立刻还在原处。

## 4. 当前实现：结构债，不是像素债

### 4.1 页面机

`WorkbenchPage` 现有：`loading | home | config | history | history-detail | sessions | inspection | source | preflight | confirm | running | result | error`。

`controller.ts` 为每一页写输入处理；`workbench.ts` 为每一页选 renderer。结果是：同一条实验在 `confirm` → `running` → `result` 之间丢掉滚动位置、选中项和「刚才在看哪条命令」。

### 4.2 Running 的调试器布局

宽终端默认：

```text
┌─ Timeline · Filter: ALL · browsing ─┐ ┌─ Detail ──────────────┐
│ 00:10:01  TARGET  pwsh · Get-Child… │ │ $ Get-ChildItem …     │
│ 00:10:02  TARGET  Visible response  │ │ ⎿ Mode  Length …      │
└─────────────────────────────────────┘ └──────────────────────┘
```

这是 debugger 的 Variables / Watch。成熟 agent TUI 的对应物是：列表行本身就是卡片的折叠态。右侧栏是重复，不是补充。

`timeline.ts` 把所有事件压成 `title + detail?: string + original?: string`。渲染层无法按块着色、按块折叠、按块复制。卡片语言被困在一个字符串字段里。

### 4.3 Home 是目录，不是可恢复的工作台

Grok Welcome：最近会话一键 resume，冲突和警告出现在启动面，不把用户推进设置向导。

Reprise Home：左栏四个斜杠命令，右栏状态说明书。没有「继续上次实验」「打开上次报告」作为一等动作。`Enter a task or / command` 还暗示可以输入自然语言任务，与「不把无斜杠输入交给模型改当前工作区」的产品边界打架。

### 4.4 向导与画布抢主路径

`/run` 仍走 source → preflight → confirm。审计帧为此准备了独立页面。产品要的是一次确认。三步向导是实现历史，不是用户任务。

### 4.5 密度切的是布局，不是留白

Grok 的 `/compact-mode` 减 padding；`/minimal` 退回终端滚动。信息层次不变。

Reprise 的 `wide | compact` 会改变栏数、标题和提示。同一条命令在 22b 和 22c 上是两种阅读方式。重构后密度只改字号感、边距和是否显示次要标签，不改卡片结构和折叠规则。

## 5. 目标壳

```text
┌─ Reprise  v0.1.0   C:\work\app          gpt-… · medium   Harness ●  Codex ●  Case ● ─┐
│                                                                                      │
│  Welcome                                          或                                 │
│  Experiment scrollback（可叠 overlay / viewer / actors pane）                         │
│                                                                                      │
│  ❯  /command 或筛选、搜索、确认                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  此刻能做的 3～5 个键                                                                │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

顶栏始终回答三件事：在哪个项目、Harness 是否可用、现在有没有 TaskCase。实验进行中把第三组换成：阶段、墙钟、target 回合、controller 调用。Token / 成本只在 Host 已记录时出现，否则写 `not recorded`，不估算。

Composer 始终在。Welcome 用它发现命令；Experiment 用它过滤、搜索、在允许时确认；不在这里接收会发给 Target 的自由输入。第一版仍禁止用户绕过 Controller 给 Target 打字。

## 6. 对照画布：两色对话

操作者默认只看两种东西，用两种颜色：

| 颜色 | 人话 | 内部来源 | 默认显示 |
|---|---|---|---|
| 紫 | **发给 Codex / Claude Code 的话** | 历史题目，或 Controller 真正投递出去的 `message` | 原文 |
| 青 | **这个 Agent 产品自己的屏幕** | Product Pack 把原生事件译成统一块 | 命令 / 编辑 / 搜索 / 可见回复 |

不要让小白先学 `HARNESS`、`TARGET`、`CONTROLLER`、`seq`、`Decision · SEND`。这些词可以留在 viewer 和 trace 里。

准备阶段不是对话，是带进度条的四步：恢复环境 → 复制隔离工作区 → 写入候选配置 → 启动产品。内部事件名不进这一屏。

### 6.1 统一产品屏幕（Product Pack 只做翻译）

每个 Product Pack 把该产品窗口里已经能看见的东西，译成同一组块，再由 Reprise 用青色画出来：

```ts
type ProductSurface =
  | { kind: 'command'; command: string; output?: string; ok: boolean }
  | { kind: 'edit'; path: string; plus?: number; minus?: number }
  | { kind: 'search'; query: string; hits?: number }
  | { kind: 'message'; text: string };
```

Codex 的 `commandExecution` / `agentMessage`、Claude Code 的 Bash / 可见回复，都进这四类。Reprise 不复刻任一产品的皮肤、logo 或私有 chrome。借鉴成熟 TUI 的只是层次：输入一种颜色，产品输出另一种颜色；工具默认一行，点开再看输出。不复制 Grok / Claude Code / Codex 的源码、组件名、配色表或文案。

### 6.2 默认藏起来

| 事实 | 默认 |
|---|---|
| Recovery / Isolation / stage_changed | 只进准备进度，不进对话 |
| `Decision · SEND`、rationale、Delivered | 藏；`o` 才看依据；投递失败才在紫块下标红 |
| `Visible response +N`、`Worked for`、`seq`、ISO 时间 | 不画 |
| cwd、绝对路径、`commandActions` | viewer |
| token / 成本 | Host 已记录才出现，否则不写 |

### 6.3 数据形状

```ts
type Voice = 'input' | 'product';   // 紫 / 青
type BlockKind = 'prompt' | 'command' | 'edit' | 'search' | 'message' | 'error' | 'summary';

interface ScrollbackBlock {
  id: string;
  voice: Voice;
  kind: BlockKind;
  collapsed: boolean;
  card: CardModel;
  original?: string;
}
```

`projectTimelineEvent` 仍只投影 Host 已确认的事实。Controller 的决策记录要先取出真正发出的 `message`，才生成紫色块；产品原生事件经 Pack 翻译后生成青色块。未知事件仍只进 trace。

### 6.4 折叠

| Kind | 默认 |
|---|---|
| `prompt` | 原文，不折叠 |
| `command` / `edit` / `search` | 一行；选中或失败时展开预览 |
| `message` | 跟在同一青色块里，超出 `… 还有 N 行` |
| `error` / `summary` | 展开 |

`f` 在「全部 / 发给它 / 它的屏幕」之间切换，不再按 HARNESS / TARGET / CONTROLLER 过滤。

### 6.5 Follow 与浏览

Grok：焦点在 prompt 时画布跟随最新；焦点切到 scrollback 后停止跟随，浏览选中条。

Reprise 已有 `following` / `l`。重构后：

- Composer 聚焦 ⇒ follow
- Scrollback 聚焦 ⇒ browsing，底栏提示 `l` 回到最新
- 新块到达不抢走浏览位置
- Overlay 关闭后恢复进入前的 focus 与 selected id

### 6.6 Viewer

全屏只读，盖住画布，不改 page。内容是 `original`、报告 HTML 的文本投影、或 trace 片段。`Esc` 关。禁止在 viewer 里再造第三套「字段列表」。

## 7. Welcome

Welcome 不再是两栏说明书。它是工作台封面：

```text
Reprise · C:\work\app
Harness ready · Codex login · last case: 修复登录页

Continue
  ↩  昨天的实验   candidate unknown · comparison ready · 18m
  i  导入 Codex 会话
  r  对当前 TaskCase 开跑

Browse
  /history   本地 TaskCase 与实验
  /config    端点、模型、密钥引用

❯  /
```

规则：

- 无斜杠、非命令的输入不发送给任何模型；提示改用 `/` 或列出可执行命令。
- 配置缺失是封面状态，不是强制跳转。`/config` 以 overlay 打开。
- 最近实验和最近 TaskCase 是一等动作，不必先 `/history`。

## 8. Overlay 合同

所有 overlay 共用：

- 打开时画布冻结但不卸载
- `Esc` 关闭并回到原 focus
- 宽、窄同一结构，只改列数和截断
- 破坏性动作二次确认（Grok 对危险键双击；Reprise 对开始实验、取消、删除本地记录沿用明确确认）

**Settings**：现有 `/config` 字段，不把 API key 写入 Reprise 数据文件。

**Intake**：会话列表 + 检查同层，选中即冻结，不再 `sessions` 整页换成 `inspection` 整页。

**History**：实验 / case 两级仍可，但是 sheet，不是 `history` → `history-detail` 丢上下文。

**Run-setup**：一张卡片写清 source（仅缺省时）、候选、限制、预算；一个确认键。阻塞原因写在按钮旁。

**Actors pane**（可选，默认关）：四行活状态——Recovery / Controller / Target / Comparison 各自的当前动作、预算余量、是否在等。主画布不复制这些心跳。

## 9. 代码重构

目标不是在 `pages/run.ts` 再改 `detailLines`。目标是拆掉页面机。

```text
src/tui/
  app.ts                 AppModel：surface + overlay + effects
  actions.ts             键盘与斜杠 → Action
  effects.ts             打开报告、启动实验、取消、写配置
  surfaces/
    welcome.ts
    experiment.ts
  scrollback/
    project.ts           EventEnvelope → ScrollbackBlock（从 timeline.ts 迁出）
    merge.ts             itemId / stream 合并
    render.ts            折叠、turn 头、卡片
  cards/
    tool.ts
    decision.ts
    delivery.ts
    message.ts
    summary.ts
  overlays/
    settings.ts          现 pages/config.ts
    intake.ts            现 pages/intake.ts
    history.ts
    run-setup.ts         合并 source/preflight/confirm
    viewer.ts
    help.ts
    actors.ts
  chrome/
    header.ts
    composer.ts
    hints.ts
  theme.ts / widgets.ts / viewport.ts   保留，去掉「按 page 选栏数」
```

`controller.ts` 收缩为 effect 宿主（实验生命周期、取消、打开报告）。它不再知道 13 种 page。

`workbench.ts` 收缩为：header + surface + optional overlay + composer + hints。Running 专用的 `HStack(list, detail)` 删除。

`timeline.ts` 的投影白名单和合并规则迁到 `scrollback/project.ts`，单测跟着走。字符串 `detail` 只作为卡片的序列化回退，不再是渲染真源。

测试：

- 投影单测继续钉 Host 事实，不钉「右栏有没有 seq」
- 卡片单测钉折叠/展开文本
- 键盘流测 Welcome → overlay → 画布，不再测三步向导整页跳转
- `tui-visual-audit.mjs` 按表面重做帧：Welcome、Run-setup overlay、Experiment 折叠、Experiment 展开命令、Viewer、Result-in-canvas；删除「左列表右 Detail」作为基准的 22b/22c

## 10. 交互（第一版只保留这一组）

| 键 | 作用 |
|---|---|
| `/` | 命令；Welcome 与 Experiment 同一套发现 |
| `Tab` | Composer ↔ Scrollback |
| `↑` `↓` | 选块 |
| `Shift+↑` `Shift+↓` | 按 turn 跳 |
| `Enter` | Welcome：执行命令；Scrollback：展开/收起；Viewer：已打开则无效 |
| `o` | 打开当前块 original / 报告 |
| `t` | 打开 trace（仅结果收束或错误块） |
| `f` | 来源过滤 |
| `l` | 回到最新并 follow |
| `/find` 或浏览态 `/` | 画布内搜索（P2） |
| `Esc` | 关 overlay / viewer；实验中第一次不取消 |
| `Ctrl+C` | Welcome：退出；Experiment 运行中：请求取消；收尾中第二次：强制退出 |
| `?` | 命令与按键 overlay |
| `Ctrl+G` | 开关 Actors pane（P2） |

不在第一版做 vim mode、鼠标点选、command palette 全量模糊搜索。`?` 先当帮助 overlay，够用再升级成 Grok 那种 palette。

## 11. 分阶段

每一阶段都必须能独立合并：用户看到的是整屏隐喻在变，而不是又改了一处文案。

### P0 — 画布替换 Running / Result

- `running` 与 `result` 合成 Experiment 表面
- 删除默认左右分栏
- `ScrollbackBlock` + 卡片渲染
- 结果摘要作为画布最后一块，不再换页
- 视觉审计重做运行帧
- 产品边界测试保持：无斜杠输入不进 Target

### P1 — Overlay 化

- config / intake / history / run-setup 改为 overlay
- 删除 `source` `preflight` `confirm` 整页
- `controller.ts` 去掉 page switch
- Home 改成 Welcome 封面

### P2 — 侧栏、viewer、搜索

- Actors pane
- 全屏 viewer
- 画布搜索
- 底栏改为状态函数

### P3 — 密度与恢复

- compact 只减留白
- Welcome 一键继续最近实验
- 可选：实验画布在进程内保持，overlay 不再卸载投影状态

不把 P2/P3 的键位或侧栏提前塞进 P0。P0 的完成定义是：跑一次实验时，操作者只面对一条时间河。

## 12. 验收

用户在 `reprise tui` 里用键盘完成：

1. Welcome 上看懂能否跑，而不是先读两栏说明书
2. `/intake` 不离开封面隐喻（overlay）
3. `/run` 一次确认
4. 运行中只滚动一条画布；命令、决策、投递是卡片，不是「左标题右调试字段」
5. 结束后仍在同一画布看到 Comparison 收束，按需 `o` / `t`
6. 任何时候 `Esc` 或 `/home` 能回到 Welcome，运行中的取消语义不变

证据：重做后的 `docs/tui-audit/` 帧、一次真实 Codex TaskCase 走查、现有 `npm test` 投影与键盘流。

明确失败信号（出现任一条就说明还在局部打补丁）：

- Running 默认仍渲染 `Timeline` + `Detail` 双栏
- `WorkbenchPage` 仍超过 Welcome / Experiment 两种表面
- 卡片正文靠 `detail: string` 里塞标题行来模拟结构
- 窄终端把同一信息改写成另一种层次
- 为了「更像 Grok」加了自然语言改当前仓库、Plan 模式或 marketplace

## 13. 非目标

- 不改变 Recovery / Controller / Comparison / Candidate 的权限与事实归属
- 不把 TUI 做成 Target Runtime 的可写会话
- 不新增 Product Pack、第二套事件协议或新的凭据存储
- 不在本计划里重做 Comparison 报告 HTML
- 不复制 Grok 的主题、logo、文案或私有 slash 集合

---

实施时先改壳（P0），再搬页面（P1）。若只改 `commandDetail` 或 `detailLines`，视为偏离本文。
