# 决策：卡面图片必须成对

状态：accepted
日期：2026-09-16

## 问题

N6 发布页在历史会话无终稿图时，仍把当前会话配图放进 `visual-evidence`，对侧写「未挂载预览」。读者看不到对照，只看到一侧成品。十秒卡曾允许「缺侧写无预览、有图侧最多一张」，这会把单侧图当成比较。

## 决定

卡面（header、headline、`key-differences`、`visual-evidence`）只允许同时出现历史终稿图与候选终稿图。不成对则 `visual-evidence` 留空；单侧图用文字写在对照区即可。发布时若卡面解析到的媒体只覆盖 baseline 或只覆盖 candidate，则 `report_incomplete`。折叠审计里的媒体目录不受此限制。`media.json` 仍可列出单侧图供调查。

## 备选方案

**保留 pair-pages 空单元格。** 空格仍占首屏，没有比较信息。

**Host 静默删掉单侧图后仍发布。** 写卡模型不知道规则被改写，下次继续贴图。

**只改 prompt、不改发布检查。** N6 已经证明模型会把「未挂载预览」当成合规。

## 影响

替代 [十秒比较卡](./2026-09-15-comparison-ten-second-card.md) 中「单侧有图时缺侧写无预览」的范围。成对终稿仍用 `pair-pages`；无图任务继续用表或短段落。

## 验证

`test/application/comparison-publication.test.ts`：两侧各一张可发布；仅候选图为 `report_incomplete`。`test/application/comparison-report.test.ts`：compose 要求单侧则留空。反向：单侧 `visual-evidence` 仍能发布则红。`npm run check` 必须通过。
