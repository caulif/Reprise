# 决策：卡面身份为历史会话 / 当前会话，去掉写卡行，Token 直接对照

状态：accepted
日期：2026-09-16

## 问题

十秒卡把写卡 Harness 印成「本卡由 {model} 写出」，读者会把写卡模型当成被测一方。对照叙述用「历史侧 / 候选侧」，不像两次会话。有人把 Host Token 总量说成因缓存、reasoning 或产品不同而不可比，卡面因此不敢直接读两个数字。

## 决定

可见卡面左右身份固定为 **历史会话** 与 **当前会话**（英文 Historical session / Current session）。禁止「历史侧」「候选侧」。内部字段、路径和 `reportFacts.models.baseline` / `candidate` 名称不变。指标卡 `.who` 仍是两个被测模型 ID。

任何模型都不在可见卡面写「本卡由 … 写出」，缺 ID 也不留空行。`reportFacts.models.comparison` 只进 facts 与审计 JSON。

卡底 Token 按 Host 投影的双侧总量直接左右对照，与时间、费用同一套阅读方式。不因缓存、reasoning 分项或产品不同在卡面声明「不可比」。无 Token 仍写未采集。

Host 用 locale 词表印「任务描述」「主要结论」以及「历史会话」「当前会话」。Agent 只填插槽正文。发布页可见区域只有 `.share`；审计 zone 留在 DOM 且 hidden，没有「价格与证据」`<details>`。

## 备选方案

**继续印写卡行。** 读者把 DeepSeek 当成被测模型。

**列名保留「历史 / 候选」。** 与两次真实会话的阅读目标不符。

**因口径不同把 Token 标成不可比。** Host 已经用同一套聚合规则投影两侧；卡面要的是这两个数，不是再解释一层。

## 影响

替代 [十秒比较卡](./2026-09-15-comparison-ten-second-card.md) 中「Host 印本卡由」的范围；写卡模型仍写入 `models.comparison`、不进 vs 行仍有效。可见身份替代 [可分享卡版式](./2026-09-14-comparison-share-card-layout.md) 中缺 ID 时写「历史」或「候选」的读者文案。Token 算法仍见 [指标壳](./2026-09-11-comparison-host-metrics-shell.md)。N6 复刻公平仍见 [单卡与 N6 复刻](../../plan/2026-09-16-share-card-and-n6-replay.md)。

## 验证

发布 HTML 可见树不含「本卡由」，不含「历史侧」「候选侧」；含「历史会话」「当前会话」（或英文对应词）。Token 格在有总量时出数字，不出现「不可比」。反向：headline 含 `<strong>`、share 内链接带 underline、任意 comparison 模型仍印写卡行，或卡面把 Token 标成不可比，则红。落地后 `npm run check` 必须通过。
