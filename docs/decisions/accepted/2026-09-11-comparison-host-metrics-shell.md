# 决策：对照报告指标壳由 Host 所有，卡下仍由 Agent 撰写

状态：accepted
日期：2026-09-11

## 问题

成功 `report.html` 若整页交给 Comparison Agent 发明，时间、token、费用会被漏抄、只写候选、或用停机状态占格；任务说明会铺成需求清单。硬指标本是确定性算术，不该再经过模型填数。[自由报告形式](./2026-09-02-comparison-free-report-form.md)禁止固定章节骨架，与「首屏必须有双侧对照数字」冲突。

## 决定

阅读顺序固定为标题与一句任务、三张 Host 指标卡、Agent 撰写的关键差异与过程。四轮 Session 编排不变。

标题和一句任务由 Agent 填写；任务句在桌面宽度下单行，不写需求列表。三张卡只放时间、token、费用，每张卡内 Baseline | Candidate 对切，只出数字和单位。三张卡同色，不上胜负色；缺测写「未采集」，不用 0。速度、回合数、Controller `satisfied` 不占卡位。

Host 在第三轮开始前把 `report.html` 写成壳，并填好 `data-host="metrics"` 中的数字。Agent 改标题和任务句，在卡下追加正文，不得改卡上数字。第四轮后 Host 核对 metrics 块与投影一致；被改过则对照 attempt 失败，不发布该次 HTML。Host 不解析关键差异 DOM，不恢复固定章节模板，不检查审美。

`reportFacts` 投影双侧时间、token、费用；TUI 结果行与卡读同一套。Token 与费用算法跟 cc-switch 会话账：展示值为 fresh 输入 + 输出 + cache creation + cache read；Codex 优先对每条 `last_token_usage` 加总，`total_token_usage` 只作无 last 时的水位；Claude 对各条 `usage` 相加。费用用内嵌单价表 × 分项，不用 Claude `total_cost_usd`。无分项或无单价则该侧保持缺失。

本决定替代 [自由报告形式](./2026-09-02-comparison-free-report-form.md) 中「Agent 发明整页首屏、不规定组件」对硬指标条的范围；替代 [Agent 创作 HTML](./2026-08-15-comparison-agent-authored-html.md) 中「Host 不检查指标卡」。页面结构、Host 区域与发布校验见 [直接编辑 HTML 与 Host 区域](./2026-09-13-comparison-host-zones-and-direct-html.md)。卡下差异判断、薄信封、失败不覆盖成功报告仍按上述记录。

## 备选方案

**继续整页由 Agent 填写硬指标。** 与可分享比较卡的阅读目标一致，但实测会漏抄或只写一侧。

**Host 在发布时重写指标条、不使 attempt 失败。** 读者看到的数字正确，但 Agent 无法知道页面已被改，审阅轮失去意义。选择发布前失败。

**为 Baseline/Candidate 配色或把速度放进第四张卡。** 颜色暗示排名；速度不是本批合同。不上色，不上速度卡。

## 影响

Comparison 仍是卡下 HTML 的作者。briefing 继续提供 `reportFacts`；壳上的数字以 Host 投影为准。可见列名与阅读顺序见[可分享卡版式](./2026-09-14-comparison-share-card-layout.md)。审美与真实模型比较卡内容不进确定性门禁。单价表查找方式见 [价格快照与 ID 清洗](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md)。

## 验证

`test/application/session-usage.test.ts`：Codex `last_token_usage` 加总、只用 `total_token_usage` 水位、Claude 各轮 `usage` 相加；无单价则无费用。`test/application/comparison-report.test.ts`：壳数字等于投影；改 metrics 数字则失败。`test/snapshots/comparison-system-prompt.txt` 要求保留 Host metrics 块。`npm run check` 必须通过。
