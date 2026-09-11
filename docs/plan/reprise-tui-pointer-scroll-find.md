# 规划：指针、视口滚动与查找范围

本文是操作者输入面的目标合同，不是当前产品规范。树时间线、子弹色与运行页无 overlay 仍以[方案 A](./reprise-tui-live-expand.md)为准；短句脊以[内部 Agent Trace](./reprise-tui-recovery-trace.md)为准；真终端宿主证据仍走[平台矩阵](./2026-09-08-platform-evidence-matrix.md)。本机草图：`docs/research/reprise-tui-operator-canvas.html`，不受控，不拥有验收。

操作者要能**滚看得见的记录**、**点得开产物**、**只在值得搜的页查找**。页脚只列点不到的键。

## 完成判据

- 恢复页（`runPhase === 'recovery'` 或准备态 `preparePhase === 'check'`）页脚无 `[/]`；按 `/` 不进入查找条。候选运行页、对照过程页保留 `/`。
- 结果页单击产物短标签与 `o` / `t` / `w` 打开同一目标（报告、记录目录、隔离副本）。单击未命中标签时不误开文件。
- 运行画布：滚轮在内容超出视口时改变 `readingOffset`（视口跟着走），不只移动选中条；选中条被滚出视口时跟进。↑↓ 仍移动选中；选中贴边时同样带动视口。
- 封面、列表、核对、选择、结果的可滚区接同一套 SGR 64/65，行为是滚视口或移光标（该页有光标则移光标并在贴边时滚），不是把事件丢掉。
- 页脚不重复已经画在主列、可点的短标签。结果页离开动作只留 Esc。运行页查找只在允许查找时出现。
- `v` 仍关闭鼠标报告。阅读模式下列表/结果不再抢滚轮。
- 假终端：注入 SGR 滚轮必须改变 offset 或列表光标；结果页注入单击坐标必须走到 `openReport` / `openTrace` / `openReplica`。反向：恢复帧出现 `[/]`、查找扫 `original`、单击空白打开文件则红。
- 改 TUI 后 `npm run check`（含重生触及的 `docs/tui-audit/frames/`）。同批更新 [`docs/product/tui.md`](../product/tui.md) 与 ADR。

## 不在本批

- 解析 `message.content`、改 Pack / 信封、恢复运行页 overlay。
- 承诺所有宿主同时：无修饰拖选 + 应用滚轮 + 终端原生跟 OSC 8。鼠标报告开着时由应用处理点击；`v` 把拖选交给宿主。
- 用 HTML 或 Cursor 合成输入关闭真终端 IME / 拖选矩阵。
- 封面 `/` 改成时间线查找。历史列表筛选用现有 Ctrl+F，不并进画布 `/`。
- 把查找做成跨实验全局搜索。

## 问题

方案 A 把 SGR 64/65 接到运行页，行为等同 ↑↓ **移动选中**。`ScrollView` 仍是 `follow: 'none'`。滚轮步进为 ±1，进不了阅读模式那条 `|amount| >= 10` 的视口偏移。长记录上看起来像「滚轮没滚页面」。

运行页一启动就开鼠标报告（1000/1002/1003）。Windows Terminal 把点击和滚轮交给应用，**不会**去跟 OSC 8 `file:` 超链接。`fileLink` 只在能力位为真时发序列；`clickCanvas` 只切 `▸` / 选中，结果页单击没有命中图。打开产物仍只靠键盘。操作者看见带下划线的「报告」却点不动。

[`docs/product/tui.md`](../product/tui.md) 把恢复和候选运行写成同一套页脚，都有 `/`。恢复时间线短、条目少、查找没有操作者价值，等于死键。

页脚同时列出 `o`/`t`/`w` 与框内短标签时，同一离开动作写两遍。规则应是：**点得到的不写快捷键；同一离开动作只留 Esc。**

## 合同

### 查找

| 页面 | `/` |
|---|---|
| 封面 | 应用命令入口，不是画布查找 |
| 恢复 / 准备检查 | 无动作，页脚不出现 |
| 候选运行、对照过程 | 查找已投影标题与短文案（含折叠组内标题），不匹配 `original` |
| 结果 | 不进入画布查找（与[运行页页脚](../decisions/accepted/2026-09-04-running-page-watch-only-footer.md)一致） |

### 点击

单击只处理 SGR **按下**，拖动产生的 move 不当单击。

| 命中 | 行为 |
|---|---|
| 运行页 `▸` | 与 Enter 相同：切换 `expandedFolds` |
| 运行页其他可见条 | 选中该条，暂停跟随 |
| 结果页短标签（报告 / 记录 / 隔离副本 / 开始对照） | 与对应键盘相同 |
| 未命中可点区域 | 忽略，不打开文件 |

命中用渲染时记下的行、列区间（标签文本，不含 OSC 包装）。不要依赖宿主跟超链接。历史详情若已有 `o` 打开报告，单击同一标签走同一 `openReport`。

结果页**保持**鼠标报告，由应用打开路径。不要为了「让终端跟 OSC 8」在结果页关掉鼠标报告——那会与运行页模型分裂，且宿主行为不在假终端里可证。

### 滚轮与视口

| 输入 | 行为 |
|---|---|
| 滚轮上/下 | 先移选中/光标一格；若该格已在视口边缘外或移动会使选中离开可见区，则改 `readingOffset`（或该页等价滚动位置） |
| PageUp / PageDown | 大步改视口，保持现有阈值 |
| Home / End / `l` | 现有：最早可见条 / 跟随最新 |
| `v` | 关闭鼠标报告；滚轮交还宿主（若宿主支持） |

假终端注入 SGR 64/65 必须能在「条目数 > 视口行数」的夹具上改变 offset，不能只断言 `timelineSelected` 变了。

### 页脚

页脚只列**该页会响应且主列点不到**的键。

| 页面 | 页脚保留 | 不写在页脚 |
|---|---|---|
| 恢复 | Ctrl+C、Enter 展开、`v` | `/` |
| 候选运行 | Ctrl+C、`/`、Enter、`v` | `o`、伪输入 `>` |
| 结果 | Esc；对照未运行时若没有可点「开始对照」才写 `c` | 与短标签重复的 `o`/`t`/`w` |
| 封面（有最近实验且该行可点） | `/`、Ctrl+C | 与「最近一次」重复的 Enter，除非该行不可点 |

`?` 仍打开本页按键说明，可列出键盘等价键；页脚本身不重复。

## 落地顺序

1. **查找范围。** `runningHints(..., allowFind)`；恢复/准备检查吞掉 `start-find`。审计帧：恢复运行无 `[/]`，候选运行仍有。
2. **视口滚动。** 画布 `move`：选中贴边时写 `readingOffset`。滚轮与方向键走同一函数。列表/结果页接 SGR 64/65。夹具：很多短条目，滚轮后 offset 非 0。
3. **单击打开。** 结果（及历史详情）布局输出 hit；`controller-input` 在 `page !== running` 时按 hit 调 `openReport` / `openTrace` / `openReplica` / `compare`。运行页 `clickCanvas` 不打开文件。
4. **页脚减噪。** 各页 `*Hints()` 与 `docs/product/tui.md` §10 对齐上表。重生 TUI 帧。
5. **ADR。** 记录：鼠标报告开启时由应用命中打开路径；恢复页无查找；滚轮带动视口。替代方案 A 里「只移选中即验收」的缺口说明，不宣告方案 A 失效。

不改 Pack、不改信封、不读 `message.content`。Windows 11 路径与进程启动规则不变。

## 文件

- [`src/tui/pages/run.ts`](../../src/tui/pages/run.ts) — `allowFind`；恢复 hints
- [`src/tui/workbench.ts`](../../src/tui/workbench.ts) — 恢复 chrome 关闭查找
- [`src/tui/controller-input.ts`](../../src/tui/controller-input.ts) — 吞恢复 `start-find`；结果/历史 click；画布 move 贴边滚视口
- [`src/tui/page-input.ts`](../../src/tui/page-input.ts) — 非运行页也消费滚轮；结果 click 带行列
- [`src/tui/pages/result.ts`](../../src/tui/pages/result.ts) / [`src/tui/widgets.ts`](../../src/tui/widgets.ts) — 短标签 hit 区间；页脚
- [`src/tui/scrollback.ts`](../../src/tui/scrollback.ts) — 选中贴边与 `readingOffset`
- 测试：[`test/tui/page-input.test.ts`](../../test/tui/page-input.test.ts)、[`test/tui/widgets.test.ts`](../../test/tui/widgets.test.ts)
- 规范：[`docs/product/tui.md`](../product/tui.md)；ADR 新建于 `docs/decisions/accepted/`
- 交接：[方案 A](./reprise-tui-live-expand.md) 的滚轮表改指向本文；[操作者画布](./reprise-tui-operator-canvas.md) 结果验收补「单击短标签」

## 验证

`npm run build` 后跑触及的 `node --test dist/test/tui/*.js`。改渲染后 `npm run check`。只改本文：`npm run verify:docs`。

真终端 Windows 滚轮与单击按平台矩阵单独记缺口，HTML 不算关闭。
