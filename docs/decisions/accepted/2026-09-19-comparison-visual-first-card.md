# 决策：对照卡视觉优先版式

状态：accepted

## 问题

可分享对照卡把文字对照放在成对预览帧之前，读者要先读段落才能看到交付物反差。Agent 在有成对终稿时仍倾向写表格或长段 prose，稀释了视觉证据。无图时 Host 已有原因段落，但版式与 prompt 未把「图优先、文为辅」写进契约。

## 决定

- 可分享卡 DOM 顺序改为：header → headline → `visual-evidence` → `key-differences` → metrics。`delivery` 与 `limitations` 仍在 metrics 之后的隐藏 `.audit` 内。
- Host 继续在 `visual-evidence` 预填成对 `pair-pages`；无法成对时写入 `data-host="visual-unavailable"` 与明确原因文案，不留空单元格。
- 卡面 CSS 放大预览帧（320px 高），并在 `.share` 内隐藏 `diff-table`、`split-compare`、`timeline`、`difference-card`，避免长表挤占首屏。
- System / compose / review prompt 要求：有成对终稿时以 `pair-pages` 为主证据，`key-differences` 仅一两句图注；有成对图时禁止卡面表格。

## 备选方案

**保持 `key-differences` 在 `visual-evidence` 之前。** 与「视觉优先」产品目标冲突；读者仍先读 prose。

**只靠 prompt 压缩 prose，不改 DOM 顺序。** 无法改变首屏扫读路径；发布门禁也无法校验区块顺序。

**无图时仍显示空 `pair-pages` 格。** 已在 [成对视觉 only](../archive/accepted-2026-09/2026-09-16-comparison-paired-visual-only.md) 弃用；继续用 Host 原因段落。

## 影响

- `comparison-report-shell.ts` 模板顺序与 CSS；`comparison-html.ts` 分享卡顺序校验。
- `comparison-agent.ts` 各轮 prompt；`comparison-system-prompt.txt` 与报告壳快照随实现更新。
- 替代 [十秒比较卡](../archive/accepted-2026-09/2026-09-15-comparison-ten-second-card.md) 中 `key-differences` 先于 `visual-evidence` 的 DOM 顺序部分；成对图纪律仍有效。

## 验证

- `test/application/comparison-publication.test.ts`：`headline < visual-evidence < key-differences < metrics`；`key-differences` 先于 `visual-evidence` 则发布失败（反向用例）。
- `test/application/comparison-report.test.ts`：compose/review 含 visual-first 与 unavailable-reason 措辞。
- `test/snapshots/comparison-report-zh.txt` / `comparison-report-en.txt`：区块顺序与 CSS 变更。
- `npm run check` 必须通过。
