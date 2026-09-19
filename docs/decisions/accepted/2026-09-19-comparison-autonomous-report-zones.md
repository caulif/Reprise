# 决策：自主任务比较报告区与安全发布

状态：accepted

## 问题

可分享对照卡把 Agent 内容拆成固定的 `visual-evidence` / `key-differences` / `delivery` / `limitations`，并用 CSS 在 `.share` 内隐藏表格等组件。这迫使非视觉任务套截图模板，并把有效表格藏起来。发布时先写根 `report.html` 再拷媒体，新 attempt 还可能用同名文件覆盖旧报告资产。

## 决定

- 新报告使用 `data-report-format="2"`：主体为 `data-agent-zone="comparison"`，可选补充为 `data-agent-zone="details"`（放在可见 `<details>` 内）。Host 仍拥有 header / metrics / cost-note / evidence / process。
- 不再要求固定 `visual < diffs` 顺序；不再在 `.share` 内隐藏 `diff-table` / `split-compare` / `timeline` / `difference-card`。
- Host 可提示候选配对媒体，不按数组索引把两侧预配成最终结论；单侧真实结果可保留，但必须就近写明缺失方及原因，不得用占位图冒充对侧。
- 发布顺序：先把被引用媒体拷到内容寻址路径并校验，再写审计 `report-model.json`，最后原子替换根 `report.html`。未注册 `data:` URL 不得作为媒体逃逸通路。
- `ComparisonReportModel` 增加可选 `formatVersion=2` 与 `comparison` / `details` slots；缺省仍可读旧四区审计文件，不批量改写历史 model。

## 备选方案

**只改 CSS 取消隐藏、保留四区。** 仍强迫 Agent 填空视觉段；Prompt 与发布门禁继续绑死旧顺序。

**成对图才允许上卡（继续 strip 单侧）。** 一侧无法恢复时读者看不到任何成品，也无法就近读限制。

**原地覆盖 `media/<basename>`。** 新 attempt 失败会破坏旧成功报告引用的字节。

## 影响

- `comparison-html.ts`、`comparison-report-shell.ts`、`comparison-publication.ts`、`comparison-visual-evidence.ts`、`comparison-schema.ts`、`comparison-report-strings.ts`。
- 替代 [视觉优先版式](../archive/accepted-2026-09/2026-09-19-comparison-visual-first-card.md) 中固定四区顺序、卡面隐藏组件、以及「不成对则去掉图片」的发布条款；身份 / Host 事实纪律与成对优先展示意图仍有效。
- Comparison Prompt 四轮措辞由后续 B7 与模板对齐；本决定先落地布局与发布契约。

## 验证

- `test/application/comparison-publication.test.ts`：`header < headline < comparison < metrics < details`；表格组件不被 `.share` 隐藏；单侧图可发布且带缺失说明；错误 Host 指标仍拒绝。
- `test/application/comparison-visual-evidence.test.ts`：缺图诊断按来源事实区分。
- `test/snapshots/comparison-report-zh.txt` / `comparison-report-en.txt`：format-2 结构。
- `npm run check` 必须通过。反向：缺 `comparison` 区、或先写 HTML 再丢媒体导致旧资产被同名覆盖，不得作为成功发布。
