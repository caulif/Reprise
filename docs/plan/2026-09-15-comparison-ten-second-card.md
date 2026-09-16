# Comparison 十秒比较卡

本文是下一步实施的目标计划。当前规则仍以 [Comparison 架构](../architecture/comparison.md) 与 [可分享卡版式](../decisions/accepted/2026-09-14-comparison-share-card-layout.md) 为准。壳顺序、模型 ID 入标题、pair-pages 原型已落地，见 [2026-09-14 可分享卡计划](./2026-09-14-comparison-share-card.md)；本文只处理仍未关闭的身份与卡面密度。

## 问题

2026-09-15 用官方 DeepSeek Completions 对冻结 Controller 实验 N5 / G6 / N1 出卡后，读者有两类失败：

1. **认错比较对象。** 标题写 `gpt-5.6-* vs MiniMax-M3`，操作者刚把写卡的 Harness 换成 DeepSeek，于是以为页上不该再出现 MiniMax。
2. **十秒得不到结论。** 首屏是调查笔记：多段散文、宽表、全文摘录、文件清单和限制条款叠在 `.share` 卡内；真正的一句差异在对照区**下面**，滚过一两屏才看见。

版式 ADR 已经要求「约十秒看出任务、两边是谁、差在哪」。System Prompt 也写了同一句。失败来自 Host 把四个 Agent 区全部铺在卡面，加上 compose 把它们都当成必填正文。

## 三个角色，不要混进同一条 vs

一次 Comparison 涉及三个模型身份，职责不同：

| 角色 | 来源 | 出现在 vs 标题？ | 这次 N5/G6/N1 的值 |
|---|---|---|---|
| 历史侧 | `reportFacts.models.baseline` ← 冻结会话 `sourceRuntimeEvidence.model` | 是，左栏 | `gpt-5.6-terra` / `gpt-5.6-sol` |
| 候选侧 | `reportFacts.models.candidate` ← 本次 Candidate Run | 是，右栏 | `MiniMax-M3` |
| 写卡算子 | 本次 Comparison Session 实际调用的 Harness 模型 | 否 | 操作者配置的 `deepseek-flash` |

切换 Harness 只换**写卡的人**，不换被比较的候选。N5/G6/N1 是 2026-09-12 已跑完的 MiniMax Controller 实验；`comparePersistedExperiment` 只读封存快照，不会重跑候选。标题里出现 MiniMax 是对的。

另外两处会加重误读，需要改 Host，不能靠 prompt 解释：

1. **卡面不公布写卡算子。** `reportFacts.models.comparison` 已有字段，壳不用它。读者只能从 vs 行猜「现在用的是谁」。
2. **该字段取错次。** [`comparisonModels`](../../src/application/comparison.ts) 从 **Candidate Run 的** `run.manifest.comparison.requestedModel` 取值。N5 本次 attempt 的 `briefing/facts/context.json` 里 `models.comparison` 仍是 `MiniMax-M3`，即使 Session 实际走 DeepSeek。对持久化重比，必须用本次注入的 `agentConfig`（当前 Harness），不得沿用当初创建实验时钉在 RunRecord 里的 Comparison 配置。

目标：vs 行永远是历史模型对候选模型；写卡算子单独成一行小字，例如「本卡由 deepseek-flash 根据冻结实验写出」，放在标题下或卡底指标旁，不进左右栏。

## 三份出卡的阅读失败

以下是对已发布 `report.html` 首屏的观察，不是审美打分。共同结构：header → `key-differences` → `visual-evidence` → `delivery` → `limitations` → `headline` → 指标。headline 被压到对照长文之后，与 [版式 ADR](../decisions/accepted/2026-09-14-comparison-share-card-layout.md)「对照区之后、指标之前的一句差异」字面相符，但对照区本身已经超过一屏。

### N5 周报

首屏先出现一条与 headline 几乎同义的加粗长句，再是 6 行对照表（含「第一次命中的对象」这种过程项），再是三张解释「为什么」的 difference-card，再左右摘录两侧周报全文。用户真正要的结论（短稿 vs 长稿、要不要落表）被论证淹没。`.task { white-space: nowrap }` 在宽屏把任务句裁成一行，长句被切掉。

### G6 讨论稿

三张等权 difference-card，没有先给「能不能互相顶替」。对照区用散文复述同一事实。`delivery` 列出 `runId`、21 条路径、测试式 JSONL，违反「卡面不放内部 ID」。headline（产品基线 vs 方法进代码）质量足够，但出现在折叠前的长文之后。

### N1 PPT

表已经够用：环形图没还原、图例项数、越界检测、落点。后面仍跟一张「需要人工处理」的长卡。`visual-evidence` 在历史侧无图时堆四张候选 PNG，且正文写「未查看图像」——图占满首屏，却声明不做视觉结论。`pair-pages` 未用。

## 根因

**Host 把调查区做成卡面。** [`renderComparisonReportShell`](../../src/application/comparison-report-shell.ts) 把 `delivery` 与 `limitations` 放在 `.share` 内、headline 之前。审计 `<details>` 只收了价格口径、证据目录和过程。Agent 按 zone 注释如实填满，卡就变成报告。

**compose 把四个 zone 写成必填作文。** 提示词禁止「2–4 张差异卡当骨架」，但同时要求填写 key-differences、visual-evidence、delivery、limitations，并复制 difference-card / split-compare / diff-table。模型用上全部原型。审阅轮检查「十秒能否说出差在哪」，但看不到渲染首屏，只能读 HTML 源码，无法发现折叠失败。

**结论位置错误。** 用户先要「差在哪、我还要做什么」；论证、摘录、路径、回放限制是复核材料。当前顺序相反。

**data-claim 与篇幅互相打架。** 核验句必须带锚点，模型用整段已核验散文满足门禁，而不是一句结论加一个短名链接。

## 目标卡（十秒）

读者不滚动、不点开 `<details>`，只应得到：

1. 这是什么任务（类别一词 + 一句人话）。
2. 左谁右谁（两个模型 ID）。
3. 差在哪（一句 headline，**先于**任何论证）。
4. 用户还要不要自己动手（至多一行；没有则省略）。
5. 有成对终稿图则左右各一张关键画面；没有则一张不超过五列的对照表，或一段不超过三行的 split。
6. 卡底三个数：时间 / Token / 费用。
7. 写卡算子一行小字，不进 vs。

其余一律默认折叠：完整摘录、文件清单、回放限制、配置差、路径、runId、attemptId、价格口径、证据目录。

### 卡面允许的 Agent 材料

`key-differences` 只准一种主对照，且二选一优先图：

- 有成对终稿媒体：只复制 `pair-pages`，每侧最多一张（或逐页但默认只展开第一页；其余进折叠）。
- 无成对图：一张 `diff-table`，表头为比较项 / 左模型 / 右模型，**最多五数据行**，只放改变用户决策的项（交付形态、关键缺口、用户补做）。禁止过程行（先扫了哪边会话库、Controller 确认轮数）。

禁止在卡面同时出现：加粗判断段落 + 宽表 + 多张 difference-card + 全文摘录。`difference-card` 若使用，全卡最多一张，且不得重复 headline。

`visual-evidence`：无成对终稿则留空，不要用「没有图所以贴全文」填满。单侧有图、对侧缺图时，缺侧写「无可用预览」，有图侧最多一张；禁止四张 montage 占满首屏。声称未查看像素时不得把图当作视觉结论的主证据。

`delivery` / `limitations`：移出 `.share` 卡面，进入卡下已有 `<details class="audit">`（或并列第二个默认折叠块）。卡面上的「用户还要做」若需要，用 `key-differences` 表的最后一行或 headline 后一句，不单开调查区。

`headline`：移到对照区**之前**（标题与任务之后）。信封仍是同一句；上限保持 280 字，compose 要求「一句、不论证」。Host 不按字数失败发布（审美仍不进门禁），但审阅 prompt 把「headline 是否被长文挡住」改成结构检查：headline 必须在第一个 Agent 对照之前。

任务句：去掉 `.task { white-space: nowrap }`，允许换行；禁止本机路径。

## 目标规则（落地时写 ADR）

实施时同批 ADR，部分替代 [可分享卡版式](../decisions/accepted/2026-09-14-comparison-share-card-layout.md) 中「四个 Agent 区都在 header 与 metrics 之间平铺」的范围。Host 数字、短引用、无可见 status 卡、失败不覆盖成功报告仍有效。

1. **vs 只比较被测模型。** 禁止把 Harness / Pack / 写卡算子写入标题或指标列名。
2. **写卡算子是 Host 文案。** 本次 Session 的 Comparison 模型 ID 写入 `reportFacts.models.comparison`，壳渲染一行；Agent 不得改。持久化重比用当前 `agentConfig`，不读 RunRecord 里过期的 `manifest.comparison`。
3. **可分享卡 DOM 顺序：** header（含算子一行）→ headline → 对照（仅 `key-differences`，必要时极短 `visual-evidence`）→ 可选一行用户补做 → metrics。`delivery` 与 `limitations` 只出现在卡外折叠区。
4. **Host 不审美打分，但约束骨架。** 发布失败条件可增加：`delivery`/`limitations` 若仍出现在 `.share` 内则 `host_zone_modified` 或新失败码；headline 若位于 `key-differences` 之后则发布失败。不限制措辞，不数汉字。
5. **Prompt 压缩对照，不压缩调查笔记。** `work/comparison-plan.md` 仍可详尽；`report.html` 卡面必须压缩。compose 删除「四个 zone 都写满」的暗示。

## 壳与事实

### `reportFacts.models.comparison`

[`comparisonModels`](../../src/application/comparison.ts) / `buildReportFacts`：`comparison` 取本次 Comparison 调用的 `agentConfig.requestedModel`（或等价的当前 Harness `modelId`）。`controller` 仍可来自 RunRecord。briefing `facts/context.json` 与页脚小字同一字符串。

反向用例：对一份 `manifest.comparison.requestedModel === "MiniMax-M3"` 的冻结 Run 注入 `agentConfig.requestedModel === "deepseek-flash"`，facts 与壳必须写 DeepSeek，测试若仍断言 MiniMax 则红。

### `renderComparisonReportShell`

- `.share` 内顺序：header、headline 插槽、`key-differences`、`visual-evidence`、metrics。
- `delivery`、`limitations` 移入 `.audit` `<details>`，默认折叠；zone 名与 Agent 可写性不变。
- header 增加 Host 只读一行 `data-host-zone` 或现有 header 内元素，文案用 `comparison-report-strings.ts`（例如「本卡由 {model} 写出」）。缺 ID 则省略整行，不写 Pack 名。
- 删除 `.task` 的 `nowrap`。
- `HOST_ZONES` 出现顺序与 publication 校验按新 DOM 更新。反向：旧顺序（headline 在四个 zone 之后，或 delivery 仍在 `.share`）不得再绿。

### Prompt

只改 `COMPARISON_SYSTEM_PROMPT`、`COMPARISON_TURN_PROMPTS`、必要时 `HOST_ZONE_REPAIR_PROMPT`。快照 `test/snapshots/comparison-system-prompt.txt`。

System：保留四类差异与左右终稿纪律。写明 vs 行不是写卡模型；卡面只有 headline + 一种对照 + 可选一行补做。

Turn 3：对照区最多五列表或一对图；无成对图则 `visual-evidence` 留空；delivery/limitations 只填折叠区，且路径与 runId 只允许出现在那里；禁止用全文摘录当对照。

Turn 4：检查项改为「不打开 details 能否回答：任务、左右谁、差在哪、我还要做什么」；headline 是否在对照之前；卡面是否出现 runId/路径；单侧图是否冒充成对视觉结论。

## 实施顺序

1. **算子身份：** `comparisonModels` 改读本次 agentConfig；壳加一行；publication / briefing 测试含反向用例。
2. **壳 DOM：** headline 前移；delivery/limitations 进 audit；任务句换行；更新 `comparison-publication.test.ts` 与报告快照。
3. **Prompt 与快照：** 按上文替换；`comparison-report.test.ts` 断言 compose 含「最多五列 / visual 可空 / 算子不进 vs」，不再暗示四个 zone 必填长文。
4. **G6 定价：** 目录补 `gpt-5.6-sol`（与 terra 同一快照来源，禁止互借）；反向无行仍为价格未配置。
5. **N1 媒体：** 历史成品图进入 baseline `media.json`；按页配对；montage 不占卡面四连图；去掉双重扩展名。
6. **ADR +** [`comparison.md`](../architecture/comparison.md) 各改一句阅读顺序与 `models.comparison` 来源；本计划保持为迁移说明。

## 不做

- 不把 DeepSeek 写入 vs 标题，不把 MiniMax 从候选列名删掉。
- 不重跑 Controller / 不把持久化重比当成换候选。
- 不增加第五轮、不按 Report Model 重渲染、不在 Host 做截图匹配。
- 不把样例页或本机 N5/G6/N1 HTML 当 CI 像素基线；审美与真实模型出卡质量不进确定性门禁。
- 不重做 token 聚合与定价解析器；只补 `gpt-5.6-sol` 目录行，禁止借用 terra。
- Comparison 对照时不直接打开实验外的活 cwd；历史图经封存拷贝进入 media。
- 不在卡面做跨任务排名。

## 测试与验收

- 冻结 Run 的 manifest.comparison 与当前 Harness 不一致时，facts 与壳使用当前 Harness。
- 发布页 `.share` 内没有 `data-agent-zone="delivery"` / `limitations`；这两区在 `.audit` 内仍可被 Agent 填写。
- headline 在 DOM 中位于 `key-differences` 之前；把 headline 移回对照区之后则发布失败。
- vs 标题与指标 `.who` 不含 comparison 模型 ID。
- 任务句 CSS 允许换行。
- `npm run build` 后相关测试读 `dist/`；批次结束 `npm run check`。只改文档则 `npm run verify:docs`。

真实 DeepSeek 出卡不进默认门禁。改完后应用同一套冻结 N5/G6/N1 做一次 opt-in 重比，人工做十秒测试：不滚动能否说出结论。

## 费用卡空态（G6「价格未配置」）

N5 / N1 双侧费用都算出了金额。G6 历史侧 Token 已采集（约 10.22M），费用格显示「价格未配置」，对应 `pricingStatus=pricing_unavailable`。脚注把「未采集」留给**没有 Token**；有 Token 无目录命中才是「价格未配置」。两套文案不要混用。

原因不是 Comparison 没读 usage，而是定价表没有 `gpt-5.6-sol`。现表有 `gpt-5.6-terra` 与 `minimax-m3`，没有 sol。清洗规则禁止把同系列 SKU 互借，因此不能拿 terra 的单价去填 sol。操作者可用 `{dataDir}/model-pricing.override.json` 单独登记 sol；仓库快照要补行时必须抄自钉住来源并升 `version`，见 [价格快照](../decisions/accepted/2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md)。

实施：在 `pricing-catalog.json` 增加 `gpt-5.6-sol`（费率来自与 terra 同一份快照来源，不得手填猜测）；`model-pricing.test.ts` 断言 sol 命中且 **不等于** 借用 terra 的测试夹具。反向：目录无 sol 行时 G6 类 ID 仍为 `pricing_unavailable`。

## N1 视觉对照（历史「无图」对候选四张图）

历史 Codex 会话已经渲过同名交付：`可信代码库成果展示-第1页.png` 等到 `第3页.png`、montage 与 pptx，路径写在 `history/transcript` 的工具记录里。这些文件此刻仍在原 cwd（`C:\yanjiusheng\…\20260825ppt\`）。候选快照里也有同名三页 PNG + montage。读者预期的是逐页左右对照。

Host 实际只登记了候选图。`comparisonLinks` 对 baseline 只收最后一条助手文本（`mediaType: text/plain`）；图片只从候选 `changedPaths` 与 Host artifact 物化。`facts/media.json` 因此只有 `side: candidate` 的 media-01…04。`replay.baselineEvidence=session_claim_only`。写卡模型按索引诚实写「历史没有可用图像」，再把四张候选图堆在右栏。这不是 MiniMax 没图、也不是 terra 没做过预览，是**索引根本没挂上历史成品**。

右栏四张也不对：montage 是三页的拼图，与三张单页重复。无左图时也不该做成「空白说明 vs 四张 figure」。应对是按页配对；缺侧占位「未挂载预览」，有图侧每页一张；montage 进折叠区。

`reportHref` 出现 `candidate--montage.png.png`：`mediaId` 已保留原名里的 `.png`，复制时又拼了一次扩展名。一并修。

实施约束：Comparison 默认不读实验目录以外的活 cwd（隔离）。历史预览应在 Case Preparation / 封存时拷进 case 或 attempt 的 `history/` 媒体，再进入 `media.json` 的 `side: baseline`。若封存时文件已不可读，卡面写「历史预览未挂载」，禁止用候选四连图冒充对照。反向：仅有候选 PNG 时仍发布「左无图、右四张」且声称完成视觉对照，则门禁或审阅清单必须失败（发布失败码仍不审美打分；prompt + 人工十秒测试覆盖布局）。
