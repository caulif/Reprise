# 决策：运行画布 gutter 与层次

状态：accepted

目标见[gutter 与层次](../../plan/reprise-tui-gutter-chrome.md)。树内容仍以[方案 A](./2026-09-10-tui-option-a-tree.md)为准。

## 问题

方案 A 去掉满宽声部卡后，主列仍整行铺画布底、整句走内部/候选色。折叠与短句同亮；`warn`/`danger` 与候选桃同色；列尾时钟跟动词挤在左侧。

## 决定

- 声部只留左缘两列：内部薄荷、候选桃、Input 中性。短句、可见回复、执行条正文用默认前景。
- 折叠 `▸` 与 `⎿` 叶名 muted；live 执行条与当前选中条用可见底。失败用独立红，不与候选桃共用 RGB。
- 列尾行左动作、右时钟。`now:*` 只画在列尾，不进主列。`timelineFollowing === false` 且后方还有条时，列尾下画 `▼ N`（compact 为 `↓`）。End / `l` 仍清跟随，本决定不改 `readingOffset` 规则。
- 结果页 kv 键 muted、值正文、短标签 accent；`⚠` 走失败色。
- 默认仍铺深画布底。`REPRISE_TUI_HOST_BG=1` 不铺 `fillCanvas`，选中改 reverse / 对比底。

## 备选方案

**满宽声部卡回到方案 A 之前。** 长回复重新变成色墙。

**失败与候选共用桃色。** 停机和「候选在干活」无法区分。

**时钟跟动词同一左列。** 窄屏先丢掉耗时。

## 影响

`theme.ts` 色槽、`scrollback.ts` 树行与列尾、`pages/result.ts` 横幅、`widgets.ts` kv。真终端浅色底仍按[平台矩阵](../../plan/2026-09-08-platform-evidence-matrix.md)。

## 验证

着色主题下失败码不等于候选桃；短句与可见回复正文不整句套声部色；折叠行含 muted；列尾行末为时钟且不得写成 `working · 时钟`；未跟随时出现 `▼`/`↓`；`REPRISE_TUI_HOST_BG` 下 `fillCanvas` 不含画布 RGB。反向：主列整句薄荷/桃墙、折叠与短句同亮度、失败与候选同色、列尾时钟被截掉则红。
