# 运行画布：方案 A（一条时间线、两种子弹、列尾状态行）

本文是尚未落地的目标。选定 **方案 A**：运行页主列是**一条**可滚时间线。恢复、模拟用户、对照三页的探路同构：**Reprise 内部 Agent 共用一种子弹色**，**候选 Agent 用另一种**；不再用满宽填色声部卡，也不再给恢复 / 控制 / 对照各画一色。列尾**一行**活着状态。操作者不学「全文 overlay」。

短句脊、flush 成 `▸`、页面衔接仍以[内部 Agent Trace](./reprise-tui-recovery-trace.md)为准；候选正式正文仍只来自 `candidate.user_view_persisted`，进行中只读 `payload.live`，见[此刻行](../decisions/accepted/2026-09-10-tui-live-now-row.md)。按键合同以[阅读与交互](./reprise-tui-design.md)为准，下文与之冲突处以本文为目标。真终端点击、滚轮与拖选见[阅读锚点](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)与[平台矩阵](./2026-09-08-platform-evidence-matrix.md)。本机草图：`docs/research/reprise-tui-operator-canvas.html`（「目标逐步」= 方案 A）。HTML 不受控，不拥有验收。

主列默认仍不铺 inspect 账本、argv、compact、thinking、`message.content`。不改 Pack API major、信封 schema、不解析 `message.content`。

## `[o]` 是什么、为什么拿掉

当前产品里，运行页选中一条后按 **`o`** 会打开该条的 `original` **全文 overlay**：工具 stdout、上下文 JSON、Host 英文错误、信封原文。页脚有时写成「全文 [o]」。这是给调试员看 dump 的入口，不是操作者需要的动作。

方案 A **取消运行页「o 打开全文 overlay」**：

- 默认主列已经只给人话短句、Input 横条、候选可见回复、失败人话、`▸` 摘要。操作者不需要再学一层「打开原文」。
- Host 英文、send JSON、工具 stdout **不进主列，也不靠 overlay 给操作者看**。需要排障时打开结果页的记录目录（短标签 / `t`），不是时间线 dump。
- `▸` 展开只在**主列内**露出叶名子行（`expandedFolds`），不是弹层。
- 结果页打开 **报告 / 隔离副本 / 记录** 仍用短标签点击；键盘可保留 `r` / `t` / `w`（打开产物文件）。这不是「全文 overlay」，页脚不要再写 `[o]`。

落地时：运行页 `helpLines` / 页脚去掉 `[o]`；`dispatchCanvasInput` 的 `o` 不再开 overlay。查找 `/`、阅读 `v`、取消 `Ctrl+C` 保留。

## 方案 A 画面合同

借鉴 Codex / Claude Code 的**结构**（用户句一条、进行中一行、已完成可折、列尾活着），不复制龙虾、Wibbling、thinking、也不在运行页用 `>` 跟候选聊天。

| 区域 | 画什么 | 不画什么 |
|---|---|---|
| 顶栏 | 一行：任务叶名或截断题干 · 候选产品 · 时钟 | 「正在生成第 N 轮」；三色长图例重复产品名 |
| 主列 | 一种树：短句、`●` 执行、`▸` 折叠、Input 横条、候选可见回复 | 满宽填色声部卡；`Decision: SEND`；send JSON；会话 UUID；compact |
| 子弹 | 内部 Agent（恢复 / 模拟用户 / 对照）= 薄荷 `●`；候选 = 桃色 `●`。三种内部角色**同色**，只靠列尾「恢复 / 控制Agent / 对照Agent」和短句区分页 | 三色图例；按三个内部角色再分色 |
| Input | 一条横条（用户句），路径叶名化 | 与 JSON `message` 重复的第二份正文 |
| 列尾 | `* {声部} · {动词 叶名 或 working} · {耗时}` | 色块标题上的闪点；空 `Candidate · working` 独占一块 |
| 展开 | Enter / 单击 `▸` 在树里列出叶名 | 运行页 overlay；未展开铺文件清单 |

色块顺序改为**时间顺序一棵树**，不再「控制Agent 卡 → Input 卡 → 候选卡」三张底板：

1. 控制Agent 短句 / `▸` / 失败人话（探路多折成 `▸`；失败和即将 send 的短句展开）。
2. Input 横条钉在**即将发生的候选过程上方**（有 Input 就不再画 Decision: SEND）。
3. 候选 `●` 过程 / `▸` / 可见回复。
4. 列尾一行：谁在干活。闪点画在这条，或画在当前 `●` 执行行，不画在已取消的色块标题上。

恢复页、对照页与模拟用户页的**内部探路同构同色**。恢复与对照没有 Input、没有候选树，因此整页只有内部色。模拟用户页在同一棵树上叠候选色的 `●` / `▸` / 可见回复。选候选时背景仍是恢复终态树；进模拟用户后主列从控制Agent 重新开始；进对照后不带 Input 与候选回复。内部过程不因换页改成第三种颜色。

## 截图里已经能看见的失败

候选运行中帧（Claude Code 第 1 轮、顶栏已走 03:21）同时出现：

- 控制Agent 色块：`▸ 写入 write`（动词叠工具名）、英文 `write_denied` 整句、人话短句、然后整段 `{"type":"send",...}` JSON。
- 其下才是 Input 卡（发给 Claude Code · 后续），正文与 JSON 里的 `message` 重复。
- 候选色块只有 `Candidate · working`，没有动词、叶名、已完成工具摘要，也没有 `working (Ns)`。
- 页脚暗示 `[o]`，操作者以为乱码要靠 overlay 才读得懂。

这不是「缺事件所以空白」。控制 Agent 的过程已经投影过量；候选的过程被设计成**未结算时只留一行 now 行**，而 `runtime.tool_finished` 又把该行打回无叶名 `working`。结果：模拟用户又吵又重复，候选像死了。

Codex / Claude Code 本机 UI 不乱，是因为它们只画**一条用户可见时间线**。Reprise 在同一视口里叠了「顶栏阶段 + 生成第 N 轮 + 三色图例 + 控制Agent 独白 + 失败原文 + JSON 信封 + Input 卡 + 空候选」。信息种类比它们多一档，却没有同等的取舍。

## 候选过程为什么看不见

TUI **禁止**把 Claude `message.content` / Codex reasoning 当主列。候选进行中唯一合法信号是 Pack 写在 `runtime.tool_started` 上的 `live`（verb + 叶名）。正式助手正文要等 `candidate.user_view_persisted`。

当前投影把这条路走窄了：

1. **没有 `live` 时就是 `Candidate · working`。** thinking、中间 text、未带 `live` 的 MCP 启动都不进主列。回合开头只有这一行，是合同允许的空白，但顶栏已经 03:21 时执行条仍不写耗时，看起来像卡住。
2. **`runtime.tool_finished` 立刻换成无叶名 `working`。** 工具哪怕闪过 `read · foo.md`，一结束就消失。内部 Agent 至少还能 flush 成 `▸`；候选连摘要都没有。
3. **`runtime.visible_output` 故意不进正式列。** 测试锁死这一点。不能靠拆 `visible_output` 里的私有帧来「看到 Claude 在说话」。

目标（仍不解析 `message.content`）：

- 有 `live`：执行条为 `● 阅读 foo.md` / `● 运行 git`（中文动词 + 叶名），`itemId: now:target` 原地替换，左侧闪点。
- `tool_finished` 后**保留刚结束的动词+叶名并继续闪**，直到下一次 `tool_started` 或 `user_view_persisted`。
- 无 `live`：执行条为 `working · {elapsed}`（与顶栏同一时钟），不要只写 `Candidate · working`。列尾同步写成 `* 候选 · working · 3:21`。
- 本轮 `user_view_persisted` 到来时：执行条让位给可见回复；两次可见回复之间的成功 `live` 收成一行 `▸ 阅读证据 · N` / `▸ 写入 {叶名}`，规则与内部 Agent 同构，叶名来自已校验的 `live.leaf`，不是私有 payload。
- thinking 仍不进主列。没有 `live` 的长时间思考只靠闪点 + 耗时，不编旁白。

不把 Host 的控制Agent 短句画进候选子弹。不把 Input 再画一遍到候选树。

## 滚轮为什么没动

运行页开启 SGR 鼠标报告（含 1003 全运动）。Windows Terminal 因此把滚轮交给应用，不再滚原生缓冲。`dispatchCanvasInput` 不识别滚轮按钮（SGR 64/65）。`ScrollView` 的 `follow: 'none'` 也没有接到这些事件。方向键能移选中，滚轮两头落空。

目标：

| 输入 | 行为 |
|---|---|
| 滚轮上/下 | 与 ↑ ↓ 相同：移动时间选中并暂停跟随；内容超出视口时带动 `readingOffset` |
| PageUp / PageDown | 已有，保持 |
| 单击 `▸` | 切换展开（主列子行，不是 overlay） |
| 拖动 / 阅读模式 `v` | 不把 move 当单击；`v` 关闭鼠标报告，滚轮交还终端原生滚动（若宿主支持） |

假终端注入 SGR 滚轮序列必须能改变 `timelineSelected` 或 `readingOffset`。真终端 Windows 滚轮仍走平台矩阵。

## 主列为什么显得乱

对照 Codex/Claude Code，乱来自**重复、双语叠词、把信封当正文、满宽色块把一条对话切成三段**，不是字号。

禁止出现在默认主列：

- 与 Input 重复的 `{"type":"send",...}`。`visibleAssistantText` 只丢掉「整段都是 JSON」的块；人话后面再跟信封时，要把可解析的 JSON 对象从短句里剥掉，只留人话。有 Input 就不再把 send 信封当 narrate。
- `▸ 写入 write`、`shell_exec shell_exec`、`Candidate · read` 这种「中文动词 + 英文工具名」叠写。执行条和 `▸` 只留一个动词 + 叶名。
- `write_denied: path is outside the Host write policy.` 这类 Host 英文。失败行用人话（写入失败 · 路径不在可写范围）。**代码不进 overlay，也不进主列。**
- 顶栏「候选运行中 · Claude Code」、副栏「Claude Code 正在生成，第 1 轮」、图例再写三遍产品名。阶段交给列尾一行。

失败单独一行，插在对应声部子弹下，不把 JSON 墙顶到候选上面。

## 内部 Agent 执行条与展开

与上一节同构，补实现缺口：

1. 闪点画在 `now:{lane}` 行或列尾状态行上，不是只闪已取消的色块标题。
2. flush 把叶名写入折叠行的 `detail`（主列展开用），`itemId` 稳定；`expandedFolds` 命中才列出叶名。不再依赖 `original` overlay。
3. Tab 聚焦句柄，Enter 切换展开；`detailExpanded` 要么驱动选中条预览（主列内），要么删除。不要「Tab 声称展开、flush 却丢掉叶名」。
4. 成功完成后不要先跳回无叶名 `working`。`user_view_persisted` / 下一短句才 flush 成 `▸`。

倾向：控制Agent 探路多折成 `▸`；失败和即将 send 的短句展开。Input 钉在候选树上方。

## 键盘与鼠标

| 动作 | 行为 |
|---|---|
| ↑ ↓ / 滚轮 | 移动选中；超出视口时滚内容；命中 `▸` 不自动展开 |
| Tab / Shift+Tab | 下/上一个可展开句柄 |
| Enter | 句柄切换 `expandedFolds`（主列露出 `⎿` 叶名） |
| o | **运行页无动作**（取消 overlay） |
| 单击 `▸` | 与 Enter 相同 |
| 单击其他可见条 | 选中 |
| `v` | 关闭鼠标报告，暂停重绘 |
| 结果页短标签 / `r` `t` `w` | 打开报告、记录、副本（文件，不是 dump overlay） |

单击只处理 SGR 按下。查找态 Enter 仍是下一命中。

## 修改规划（按文件）

落地顺序：投影正确 → 渲染成树 → 输入（展开/滚轮/去掉 o）→ 页脚与顶栏减噪 → 测试与 ADR。未说「开始写代码」前只改文档与草图。

### 1. 时间线投影

[`src/tui/timeline.ts`](../../src/tui/timeline.ts)

- 内部与候选 `now:*`：`tool_finished` / 内部 `tool_completed` **保留**动词+叶名并继续作为 live 行，直到下一 `tool_started` 或 flush 边界。
- `emitFlush`：累加叶名到折叠 `detail`；`itemId` 跨 flush 稳定。
- `projectCandidateNow`：禁止在 `tool_finished` 清成无叶名 `working`。
- `user_view_persisted` 前 flush 候选成功 `live` 组（与内部 Agent 同构）。
- 无 `live`：标题含耗时，与顶栏时钟同源。
- 条目带 `voice: recovery | controller | comparison | candidate`。渲染只映射**两种**颜色：前三个 → 薄荷（内部），`candidate` → 桃色。不要按三个内部角色再分色，也不要按产品名画三张卡。

[`src/tui/agent-activity.ts`](../../src/tui/agent-activity.ts)

- 单动词 + 叶名；禁止 `写入 write`。
- 失败映射为人话；Host 英文码不进标题。

[`src/infrastructure/agent/assistant-visible.ts`](../../src/infrastructure/agent/assistant-visible.ts)

- 剥掉混在短句里的 JSON 信封，只留人话。

[`src/tui/fold-process.ts`](../../src/tui/fold-process.ts)

- 展开子行来自 `detail` 叶名列表。
- 不再把「看原文」设计成展开目标。

### 2. 渲染：树 + 列尾，不要色块

[`src/tui/scrollback.ts`](../../src/tui/scrollback.ts) / [`src/tui/pages/run.ts`](../../src/tui/pages/run.ts)

- 去掉满宽 `band` 声部底板。
- 短句无子弹或浅色前缀；执行用 `●`；折叠用 `▸`；展开叶名用 `⎿`。内部 `●`/`▸` 一律薄荷；仅候选过程用桃色。
- Input：一条横条，超长路径叶名化。
- 列尾固定一行 live status（有 now 行时与执行条动词一致；无 live 时 `* 候选 · working · 时钟`）。
- 顶栏一行任务+产品+时钟；删除「正在生成第 N 轮」和三色长图例（最多色点，不要长句）。
- 页脚：`[Ctrl+C] 停止  [/] 查找  [Enter] 展开  [v] 选择`。无 `[o]`。

### 3. 输入

[`src/tui/controller-input.ts`](../../src/tui/controller-input.ts) / [`src/tui/page-input.ts`](../../src/tui/page-input.ts)

- 识别 SGR 64/65，行为同 ↑↓。
- 单击 `▸` 写入 `expandedFolds`。
- 运行页 `o` 不再打开 overlay；删除或停用 `original` overlay 渲染路径（若仅运行页使用则删死代码，不要留无入口函数）。
- `detailExpanded`：驱动主列预览或删除，禁止空转。

### 4. 结果页（轻改）

[`src/tui/pages/result.ts`](../../src/tui/pages/result.ts)（或现结果投影）

- 打开报告/副本/记录：短标签 + `r`/`t`/`w`。页脚不写「全文 [o]」。
- 主列仍是人话终态；`limitationCodes` 不铺默认列。

### 5. 规范与决策（与代码同批）

- [`docs/product/tui.md`](../product/tui.md)：运行页取消 `o` overlay；`▸` 主列展开；结果页产物键。
- 新增 ADR：方案 A 树渲染、运行页无 overlay、滚轮改阅读位置、单击只切展开/选中。
- 更新[操作者画布](./reprise-tui-operator-canvas.md)：记录层「Enter/单击 ▸ 露叶名」，删「[o] 才打开原文」。
- [内部 Agent Trace](./reprise-tui-recovery-trace.md)：终态摘录不再写「全文 Tab / [o]」；改为主列摘录 + 结果页打开文件。

不改 Pack、不改信封、不读 `message.content`。候选 `live` 仍由 Adapter 写在 `runtime.tool_started`。

## 测试

[`test/tui/narrative-canvas.test.ts`](../../test/tui/narrative-canvas.test.ts) 与 [`test/tui/timeline.test.ts`](../../test/tui/timeline.test.ts)：

- 候选 `tool_started`+`live` 主列是动词+叶名，不是只有 `Candidate · working`。
- `tool_finished` 后叶名仍在；`user_view_persisted` 后出现可见回复，并有 `▸`（有成功 live 时）。
- 无 `live` 的 live 行含耗时数字；列尾或等价字段能投影 `working · 时长`。
- 人话+JSON 的 `assistant_visible` 主列无 `"type":"send"`；有 Input 横条。
- `write_denied` 英文不进默认标题。
- 反向：未展开铺出文件清单、`visible_output` 正文进主列、`message.content` 出现在 `timeline.ts`、运行页帧仍含 `[o]` 或 send JSON 墙则红。

补 `page-input`：SGR 滚轮改变选中或 offset；单击 `▸` 写入 `expandedFolds`；运行页按 `o` **不**打开 overlay。

`npm run build` 后再跑相关 `node --test`。改 TUI 源码后 `npm run check`。只改本文与 HTML：`npm run verify:docs`。

## 验收

假终端候选运行帧：投递后不是空 `working`（有 `live` 则叶名，无则 `working · 时长`）。主列无 send JSON、无 Host 英文墙、无运行页 `[o]`。未展开无文件名清单。注入滚轮后选中或视口偏移变化。Enter/`▸` 只在树内露叶名。

真终端滚轮、单击、拖选按平台矩阵；`v` 后滚轮不得再被应用抢掉（宿主仍可能自己滚）。HTML 不算关闭。

## 与内部 Agent Trace 的交接

[内部 Agent Trace](./reprise-tui-recovery-trace.md) 仍拥有：短句为脊、执行条一行、flush 边界、页面衔接（恢复 → 选产品/模型 → 模拟用户；`c` → 对照不带上一页对话）、DONE/对照终态人话。

本文覆盖并修正其「色块 / `[o]` / 三色图例」表述：落地时三个内部 Agent 探路画在方案 A 的树上且同色；候选用另一色；运行页无 overlay。草图「目标逐步」已按此重画。
