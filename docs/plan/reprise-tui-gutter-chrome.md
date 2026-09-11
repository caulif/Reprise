# 规划：运行画布 gutter 与层次

本文是运行页**画法**合同，不是当前产品规范。树里画什么、两种子弹、无 overlay 仍以[方案 A](./reprise-tui-live-expand.md)为准；短句脊以[内部 Agent Trace](./reprise-tui-recovery-trace.md)为准；键与指针以[指针、视口与查找](./reprise-tui-pointer-scroll-find.md)为准。本机草图：`docs/research/reprise-tui-gutter-preview.html`，不受控，不拥有验收。四档对照同一棵树：**现状一帧**（满宽色块）、**方案 A 树**（信息结构）、**视觉提案**（gutter / 明暗 / 列尾时钟，默认）、**透出宿主底**（不铺 `fillCanvas`）。运行页步进里点 `▼` 模拟 End；终态帧不画未跟随。

操作者靠**左缘颜色**分内部 / 候选，靠**明暗**分进行中 / 已折叠，不靠满行染色或第三种角色色。

## 完成判据

- 运行主列：内部条目左缘 2 列薄荷，候选左缘 2 列桃色，Input 横条保持中性竖条。短句、可见回复、执行条**正文用默认前景**，不把整句染成子弹色。
- 折叠 `▸` 与展开后的 `⎿` 叶名用 muted；`kind === 'live'` 执行条、失败行、Input、候选可见回复用满对比。当前选中条有可见底（不只加粗）。
- 失败 / 危险用独立红（或 `NO_COLOR` 下的 `✗` + 文字），不与候选桃色共用同一 RGB。
- 列尾行钉在画布底、页脚之上：左 `*{声部} · {动词或 working}`，右时钟与顶栏同源、tabular、窄屏也不丢。向上阅读暂停跟随时，列尾行下多一行 `▼ N`（或 `↓ 新 N`），End / `l` 清除。
- 结果页 kv：键 muted、值正文、短标签 accent。`⚠` 走失败色。
- 假终端：方案 A 树内容不变（无 send JSON、无运行页 `[o]`、无 `original` overlay）。反向：默认主列整句桃色/薄荷墙、折叠 `▸` 与短句同亮度、失败与候选同色、列尾时钟被截掉则红。
- 改 TUI 后 `npm run check`（含重生触及的 `docs/tui-audit/frames/`）。同批更新 [`docs/product/tui.md`](../product/tui.md) 与 ADR。

## 不在本批

- 解析 `message.content`、改 Pack / 信封、恢复运行页 overlay、thinking / 代码高亮 / diff 进主列。
- 第三种内部角色色、时装主题包、token / cost 进度条、整页 30fps 动画。
- 用 HTML 关闭真终端验收。草图「透出宿主底」只演示不铺 `fillCanvas`，浅色 WT 实测仍走[平台矩阵](./2026-09-08-platform-evidence-matrix.md)。
- 改查找范围、单击命中图、滚轮语义（已由指针规划拥有）。本批可把未跟随提示画出来，不改 `readingOffset` 规则。

## 问题

方案 A 去掉满宽声部卡之后，主列仍整行 `fillCanvas`，标题整句走 `harness` / `target` 色。长候选回复像告警墙；折叠 `▸ 阅读证据 · 12` 与短句同样抢眼；选中多半只加粗，深底上看不见。`warn` 与 `danger` 落到桃色，失败和「候选在干活」同色。列尾时钟跟动词挤在一行左侧，窄屏先丢耗时。

浅色 Windows Terminal 上画布 RGB `[12,16,18]` 盖住宿主底，和「低彩度正文、一种强调」冲突的是**铺底面积**，不是缺第三套主题。

## 合同

### 块几何

| 行类 | 左缘 | 字色 | 底 |
|---|---|---|---|
| 内部短句 / 终态词 | 薄荷 2 列 | 默认前景；成功词可 accent | 无 |
| 候选可见回复 | 桃色 2 列 | 默认前景 | 无 |
| Input 横条 | 中性 2 列 | 句正文；「已接受」muted | 现有 Input 浅底 |
| live 执行条 | 对应声部 | 默认前景；`●` 用声部色闪 | 选中底 |
| `▸` 折叠 | 声部色降至约 45% 明度 | muted | 无 |
| `⎿` 叶名 | 无（缩进） | muted | 无 |
| 失败 | 失败色 2 列或行首 `✗` | 失败色 | 无 |

不画用户/助手双底气泡。不沿线波动画。闪点只在 live `●` 或列尾 `*`。

### 列尾与未跟随

列尾行高度 1；闲时仍画「谁 · working · 时钟」，不拆成卡片。内容可截，**时钟列固定**。`▼ N` 只在 `timelineFollowing === false` 且有新条时出现，不是常驻装饰。

可选 1 列滚动条表示 `readingOffset`：有则假终端可断言位置，无则本批不红。

### 色槽

内部薄荷、候选桃，两槽够用。新增**失败红**（ANSI 31 / 独立 RGB）。成功继续用薄荷文字 + `✓` / 「已恢复」。`NO_COLOR` 只留字形与 `▸`/`●`/`✗`。

另开一档**不铺画布底**（对齐草图「透出宿主底」）：无 `fillCanvas`，选中用 reverse 或宿主可分辨的对比底。默认档仍铺深底。本批至少默认档过审计；不铺底档有假终端帧或跳过窄高亮即可，不承诺浅色 WT 一次过。

### 密度

继续按宽度切 `minimum/compact/regular/wide` 与 ASCII 框。gutter 在 compact 可改成 `|` / `:`，不得改成满宽色块。

## 落地顺序

1. `scrollback.ts` 树行：gutter + 正文默认色 + 折叠 muted + 选中底；`theme.ts` 拆 `danger`。
2. 列尾网格：左动作右时钟；未跟随 `▼`。
3. 结果页 kv 层次与失败色。
4. 重生 TUI 帧；`docs/product/tui.md` 补画法一句（不写键位表）。
5. 不铺底档（可同批或紧随）。

不改 Pack、不读 `message.content`。Windows 11 路径与进程规则不变。

## 文件

- [`src/tui/scrollback.ts`](../../src/tui/scrollback.ts) — `paintEntry` / 列尾
- [`src/tui/theme.ts`](../../src/tui/theme.ts) — `danger` 与选中底
- [`src/tui/pages/result.ts`](../../src/tui/pages/result.ts) / [`src/tui/widgets.ts`](../../src/tui/widgets.ts) — kv 与失败
- 测试：[`test/tui/widgets.test.ts`](../../test/tui/widgets.test.ts)、[`test/tui/narrative-canvas.test.ts`](../../test/tui/narrative-canvas.test.ts)（断言色码或可见层次，不锁死 RGB 全文）
- 规范：[`docs/product/tui.md`](../product/tui.md)；ADR 新建于 `docs/decisions/accepted/`
- 草图：`docs/research/reprise-tui-gutter-preview.html`

## 验证

`npm run build` 后跑触及的 `node --test dist/test/tui/*.js`。改渲染后 `npm run check`。只改本文：`npm run verify:docs`。

真终端浅色底与色盲可分辨性按平台矩阵另记，HTML 不算关闭。
