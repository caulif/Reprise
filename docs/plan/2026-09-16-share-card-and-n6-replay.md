# 单卡比较面、主流定价与 N6 复刻起点

本文是下一步实施的目标计划。当前规则仍以 [Comparison 架构](../architecture/comparison.md)、[十秒比较卡](../decisions/accepted/2026-09-15-comparison-ten-second-card.md)、[Controller 实验条件](../architecture/controller-experiment-conditions.md) 与 [Git sink catalog](../decisions/accepted/2026-09-11-git-sink-catalog.md) 为准。卡面身份、写卡行与 Token 对照以 [历史会话 / 当前会话](../decisions/accepted/2026-09-16-comparison-session-labels.md) 为准。

观察样本：2026-09-16 官方 `deepseek-flash` 对冻结实验 N5、N6 的已发布 `report.html`。本机路径不作为产品默认值。

## 问题

读者要一张可分享卡：任务、一句结论、左右对照、卡底三个数。当前页在 `.share` 之下还有默认折叠的「价格与证据」，打开后是诊断、路径清单和媒体目录。卡面标题下还有「本卡由 deepseek-flash 写出」。任务句没有「任务描述」标注，headline 没有「主要结论」标注。

N6 费用卡历史会话写「价格未配置」：Token 已采集（约 2.17M），目录没有 `gpt-6-astra` 行。同批 N5 的 `gpt-5.6-terra` 能算出金额。Host 投影的 Token 总量可直接左右对照。

N6 对照表把「候选从历史成果已经在 main 上的状态起步」写成两侧能力差。这不是写卡模型编造：Git sink 的 `initial` `refs/heads/main` 就是 `294c695`（历史会话那次 SEO 提交）。根因在 Recovery 起点与 Controller 第一句，不在 Comparison 排版。

## 目标卡

发布页只渲染一张 `.share`。读者不滚动、不展开，应看到：

1. 标题：类别一词 · 历史模型 vs 候选模型。
2. 一行标签 **任务描述：**，下一行任务句。
3. 一行标签 **主要结论：**，下一行 headline。
4. 一句主要结论之后，用**最短能说清差异**的对照：一两句话就够则不要表；需要并排列项再用表（仍最多五数据行）；有成对终稿图才用 pair-pages。表不是默认骨架。
5. 卡底时间 / Token / 费用。Token 与时间、费用一样，按 Host 投影的双侧总量直接对照，不在卡面写「不可比」。

可见身份用 **历史会话**（左）与 **当前会话**（右），不用「历史侧」「候选侧」。任何模型都不写「本卡由 {model} 写出」，缺 ID 也不留该行。`reportFacts.models.comparison` 仍写入 facts 与审计 JSON，不进可见卡面。

价格口径、证据目录、媒体目录、`delivery`、`limitations` 不出现在发布页可见区域。Host 为校验仍可把这些 zone 留在 DOM 里，但必须 `hidden` 或等价不可见，且不得再有「价格与证据」`<details>`。

## 卡面文案与样式

Host 壳用 locale 词表印「任务描述」「主要结论」，以及对照里需要的「历史会话」「当前会话」。Agent 只填插槽正文，不得再写一遍标签，也不得改用「历史侧」「候选侧」。

对照形式由写卡模型选，Host 不规定必须用表。能用一两句话对齐「左右各交了什么、用户还要不要动手」就停在段落或极短 split；只有多项并列、一句话会缠在一起时才复制 `diff-table`。若用表，行必须是改变用户决策的项（交付形态、关键缺口、用户补做），禁止过程行（复刻 SHA、sink 区间、Controller 轮数、先扫了哪边会话库）。N5 的表是「多项决策差」时的合格样例，不是所有任务的模板。

N6 这一版不合格：用表堆「起点已含历史提交」和一串文件路径锚点，读者分不清哪边是模型产出、哪边是复刻条件。这类任务更适合两句话：历史补了爬虫与结构化数据底座；候选在这份已进 main 的树上另交了社交元数据与 series——再把起点不对等放到不可见 limitations。compose 写明：若 Host 诊断或 git-sink `initial` 已等于历史会话提交，必须在 limitations 记录，不得当作候选弱项或强项写进对照。

样式（Host CSS，不靠审美打分；无表时仍适用链接与 headline 规则）：

- `.share a` 去掉下划线；证据锚点用与正文同色或极淡的区分，不要蓝链铺满单元格。
- headline 与表单元格禁止靠 `<strong>` 撑阅读层次；`data-claim` 不得改变字重。
- `diff-table` 去掉粗分割线与第一列 `.who` 的字距大写；单元格留白、字号与正文一致。
- 表内不要堆五个以上 `path-link`。

反向：headline 里仍有 `<strong>`、表内可见下划线链接仍绿，则测试红。不按像素比对 N5/N6 HTML。

## `gpt-6-astra` 与主流定价

N6 历史会话 `pricingStatus=pricing_unavailable` 的原因与 G6 的 `gpt-5.6-sol` 相同：清洗后的 ID 在钉住目录里没有行。禁止借用 `gpt-5.6-*` 或 `gpt-5` 单价。

实施时在 `pricing-catalog.json` 增加 `gpt-6-astra`，费率抄自 OpenAI API / models.dev 短上下文 Standard（2026-09-04 公开表），不得手填猜测：

| 分项 | USD / 百万 token |
|---|---|
| input | 10 |
| output | 50 |
| cacheRead | 1 |
| cacheCreation | 12.50 |

目录 `version` 升到带当天日期的 snapshot 字符串。`model-pricing.test.ts`：astra 命中且费率不等于 terra/sol；无行时仍 `miss`。

同批补当前样本与公开旗舰缺口（仍禁止同系列互借；每一行必须有钉住来源）：

- OpenAI：已有 gpt-5 / 5.1 / 5.2 / 5.5 / 5.6-terra / 5.6-sol；补 `gpt-6-astra`，并按同一份 models.dev 快照收录其它已发布的 `gpt-6-*` SKU（各写各的行）。
- Anthropic：已有 Sonnet/Haiku 4.5 与 Opus 4 / 4.1。
- MiniMax：已有 `minimax-m3`。
- DeepSeek：已有 `deepseek-v4-flash`；补官方 Completions 名 `deepseek-flash`（可显式别名指向同一费率行，不得把 V4.1 与 V4 互借）。

长上下文翻倍价不进 Host 四类单价；超窗仍用短上下文行，脚注保持「不含工具调用」。操作者覆盖文件仍优先于快照。

## N6：候选为什么从历史成果上起步

### 冻结 Case 里有什么

`case-f4452141a0bc4dd0`（Codex `01a086a1-…`，历史模型 `gpt-6-astra`）：

- `initialInput`（`message-8`）：「如何优化我这个 blog 的 SEO，给出思路和建议，**先不修改**」。
- 随后用户同意「结合实际改完」，并补「不要改完的帖子内容」。
- 历史末轮确认结构化数据、MathJax 按需加载、sitemap 等已处理，并留下可优化清单。
- `taskContext.historicalCwd` 为 `C:\blog`。`historicalEnvironment.cwd.git.isRepository` 为 **false**。**没有** `historicalCommit`。
- Codex 导入只从 `session_meta` 的 git 字段取 commit（[`sessions.ts` `commitFromMetadata`](../../src/products/packs/codex/sessions.ts)）。本 Case 未写入该字段，Host 无法在冻结时钉住「任务开始前的 SHA」。

博客的 Git 在嵌套目录 `caulif/`，不在 `C:\blog` 根。冻结把根目录判成非仓库，是探测边界问题，不是仓库不存在。

### Recovery 实际交出去的起点

[Recovery 最小 Host](./recovery-agent-minimum-host.md) 的目标是：恢复 **`initialInput` 之前** 的任务条件；任务期间产生的成果默认后继内容，应由 Agent 清掉。Host **不预先 checkout** 某个 commit 并宣布恢复完成。

N6 封存 baseline 与 Git sink 显示：

- sink `initial` `refs/heads/main` = `294c695`（`Improve site SEO metadata and crawlability`），与历史会话自己的提交相同。
- 工作区还带着更早/并行会话的未提交改动（`hugo.toml`、rename 残留、docs 草稿等）。
- 候选可见汇报：`main` 从 `294c695` → `63b7e32`，并主动把「上一会话 MathJax」单独 commit。

含义：Recovery 把**当时活 cwd 的当前树**（含历史 SEO 已经进 main、外加脏工作区）交给了候选。候选没有从「先不修改」之前的父提交开始，所以不可能复现「从零做技术 SEO 底座」这条历史路径。Comparison 把这件事写成「两侧落进 main 的东西不重叠」，对读者是对的事实、对实验是污染。

分层：

1. **Pack / 冻结：** 未记录 `historicalCommit`；Git 探测停在 `historicalCwd`，看不到嵌套 `caulif/.git`。
2. **Recovery：** 没有把「任务开始前 HEAD」当成必须达到的机械条件；复制/保留了当前 HEAD 与脏文件。信封仍可 `ready`。
3. **Git sink：** 忠实地把 Recovery 交出来的 HEAD 记成 `initial`。Comparison 读 catalog 时看到的就是污染后的起点。

### Controller 第一句

[实验条件](../architecture/controller-experiment-conditions.md) 第 6 条：历史后续轨迹用于理解协作习惯；**不得把原 Agent 后来调查得到的答案或实现路径，当作用户原本知道的事实交给候选**。Target 收到的每一句都由 Controller 写出，包括第一句。Controller **不重放**固定原文，但第一句仍必须是「这个人在候选还没做任何分析时会说的话」。

N6 候选用户输入索引：

| 顺序 | 来源 | 内容要点 |
|---|---|---|
| 历史 `message-8` | 用户 | 先分析 SEO，先不修改 |
| 历史 `message-21` | 用户 | 同意结合实际改完 |
| 候选第一句 | Controller | 「按你建议的优先级来，先做第 1 和第 2 项…」 |
| 候选第二句 | Controller | 「那就重新提一份吧…写完先别动手」 |

候选第一轮可见回复已经声明：这是会话开头，没有「你建议的优先级」清单。Controller 把**历史 Agent 已经产出清单之后**的用户口吻，当成了候选的开场。这是答案泄漏，不是「同等人类能力」。第二句才回到「重新提一份」，任务形状已经从「先分析再改」变成「在现成站点上补 OG / series」。

因此 N6 卡上的「底座已经在 main 上 + 候选另交社交元数据」是两条独立故障叠在一起：仓库起点错了，用户第一句也错了。只改 Comparison 文案不能让下次复刻变公平。

## 目标规则

Comparison 与壳：

1. 发布页可见区域只有 `.share`。审计与 Agent 折叠区对读者不可见。
2. Host 印「任务描述」「主要结论」；去掉可见算子行；可见身份为历史会话 / 当前会话。
3. compose 按「最短说清」选对照形式，不默认五列表；禁止过程行。git-sink 起点不对等写进 Host 诊断，不进可见对照。表若出现，CSS 去掉粗线、下划线与加粗撑层次。Token 按 Host 总量直接对照。

定价：钉住 `gpt-6-astra` 与同批主流缺口；禁止互借。

Recovery / 冻结（N6 根因，另批可与卡面并行，但复刻公平依赖它们）：

4. 冻结时对 `historicalCwd` **及其子目录** 发现 Git；嵌套仓写入 Case（相对路径 + HEAD）。有 `session_meta.git.commit` 则写入 `historicalCommit`。
5. Recovery 的 `ready` 必须能回答：工作副本 HEAD 是否为 **任务开始前** 的提交（优先 `historicalCommit`；否则历史会话第一笔与任务相关的 commit 的父提交）。若 HEAD 已包含历史任务提交，不得标 `ready`，除非信封显式声明 `partial` 且 Host 把该不对等写入 Run 诊断。
6. 脏工作区里、时间戳或内容能归到历史任务之后的文件，默认清掉或移出候选可见树；跑任务必需的依赖除外。

Controller：

7. 候选第一条用户消息不得引用「你刚才的建议 / 优先级 / 清单」，除非候选本回合已经产出过对应可见文本。第一句的任务形状必须与 `initialInput` 同类（本样本：先分析、先不改）。Host 不规定逐字重放，但可对第一句做浅层失败：若匹配「按你（上次）建议」且候选可见轮次为 0，则记诊断并允许实验继续或按策略重试——实施时在 ADR 里选定一种，不要静默放行。

## 实施顺序

1. **壳：** 去掉可见算子行；任务 / 结论标签；可见文案「历史会话 / 当前会话」；隐藏审计 `<details>`；CSS 去下划线与表内加粗；publication 反向用例。
2. **Prompt：** 一两句话能说清则不用表；需要并列再用最多五列表。禁止「历史侧 / 候选侧」；禁止把 Token 写成不可比；禁止把 sink `initial==历史提交` 写成模型差异；禁止 headline `<strong>`。
3. **定价：** `gpt-6-astra` + 同批主流缺口；升 `version`；测试。
4. **冻结 / Recovery：** 嵌套 Git 发现与任务前 HEAD；`ready` 机械条件；脏树。新 ADR 替代「Host 绝不预先 checkout」中与「必须交任务前条件」冲突的范围——Host 仍不替 Agent 选内容，但可以拒绝「HEAD 已含历史成果」的 `ready`。
5. **Controller：** 第一句不得引用未发生的候选建议；prompt + 可选 Host 诊断。
6. **验收：** 同批 ADR；`comparison.md` / 实验条件各改一句；本计划保持为迁移说明。N6 旧实验不重写历史 sink；要验证复刻公平需新跑 Recovery+Controller，不把旧 `report.html` 当像素基线。

## 不做

- 不把写卡算子写回 vs 行，也不以任何模型名印「本卡由」。
- 不按 Report Model 重渲染、不增加第五轮。
- 不把本机 N5/N6 HTML 当 CI 像素基线。
- 不把「必须有 diff-table」写进发布失败条件；空表或无表只要 headline 与 key-differences 非空即可。
- 不重做 token 聚合器；不把长上下文翻倍价塞进四类单价。
- Comparison 对照时仍不读实验外活 cwd。
- 不把 N6 旧 MiniMax 轨迹改写成「从未见过 294c695」。

## 测试与验收

- 发布 HTML 可见树中没有「价格与证据」summary，没有「本卡由」，没有「历史侧」「候选侧」。
- 可见区出现「任务描述」「主要结论」「历史会话」「当前会话」（随 locale）。
- 有 Token 总量时费用旁的 Token 格出数字，不出现「不可比」。
- `.share a` 无 `text-decoration: underline`；headline 无 `<strong>`。
- `gpt-6-astra` 能算出费用；无该行时仍价格未配置。
- 冻结夹具：根目录非 Git、子目录 `caulif/.git` 时 Case 能看见嵌套仓。
- Recovery：HEAD 已等于历史任务提交时不得 `ready`（或必须 `partial` + 诊断，以 ADR 为准）。
- Controller：候选 0 轮时第一句含「你建议的优先级」则红（prompt 快照或 Host 诊断测试）。
- `npm run build` 后测 `dist/`；批次结束 `npm run check`。

真实 DeepSeek 出卡与新跑 N6 Recovery 不进默认门禁。
