# 决策：对照动态证据 catalog 与派生注册

状态：accepted

## 问题

Comparison 简报一次性写出 links/media 后，`compare()` 开头拍下的短引用白名单与发布端 briefing 对象不再更新。调查中在 scratch 生成的表格、摘要或检查结果无法进入可引用、可发布、可从事件复原的证据集；新增媒体若重排短引用会破坏已写报告。缺少受控注册工具时，只能靠 Prompt 暗示「请放图」，无法贯通 Agent 与 Host。

## 决定

- Attempt 作用域持有可修订的证据 catalog（`revision`、links、media）；权威落盘为 `facts/evidence-catalog/rev-N.json` + 原子 `CURRENT` 指针；`facts/` 与 `briefing/facts/` 的 media/evidence-index 由同一 revision 派生。
- 短引用 `ev-*` / `media-*` 统一为 2–6 位数字；分配 append-only，已分配编号不因删除或失效而复用；两侧相同字节仍按 side 分属保留。
- 新增工具 `register_evidence`：只接受 scratch 相对路径与已有 sourceRefs；Host 强制 `origin=derived_analysis` / `side=derived`，禁止 Agent 自填历史原件身份。可选 `toolCallId` 必须属于本 attempt 且已 `agent.tool_completed`。
- `render_artifact` / `preview_report` 先以 `capability_unavailable` 占位，渲染与预览体由后续包实现；工具名进入 Comparison 工具面。
- `ComparisonAgent.compare` 通过同进程 `getEvidenceCatalog()` 读取当前白名单；该 getter 不进入 `comparison.requested` 持久化 JSON。`assertComparisonResult` 与 `enforcePublishedReport` 使用最终成功 revision。
- 成功注册写入事件 `comparison.evidence_registered`（attemptId、revision、shortRef、hash、source/artifact refs、派生参数）；不含媒体 base64 或私人绝对路径。mutate/persist 后若 emit 失败，同内容重试必须补发事件，不得因 dedupe 跳过。
- Catalog 落盘顺序为 `rev-N.json` → facts 镜像 → 原子 `CURRENT`。
- Link `side` 扩展 `host` | `derived`；media 可带 `sourceRef` / `contentHash` / `derivation`。`available=true` 不单独构成向模型发送图片的授权。

## 备选方案

**只扩 Prompt、不改 catalog。** 无法让发布端承认新 refs；属于假完成。

**每次注册重算全部短引用。** 破坏已写入报告中的 `data-*-ref`。

**允许 Agent 自填 `origin=historical_artifact`。** 混淆事实与推断，破坏来源纪律。

**为每个工具新建独立 Agent。** 违反「不新增研究/裁判 Agent」边界。

## 影响

- `comparison-evidence.ts`、`comparison-short-refs.ts`、`experiment-report.ts` 工具装配、`comparison-agent.ts` 动态白名单、`experiment-store` 事件校验、`comparison-schema` / `schema` 字段。
- 事实归宿：[证据、持久化与 Comparison](../../architecture/evidence-and-comparison.md)。历史终稿封存与 `finals/` 挂载由相邻包补齐；本记录覆盖动态 catalog 与派生注册。
- 不替代 [可分享任务比较卡](./2026-09-09-comparison-shareable-task-card.md) 的产品目标；不整份抹掉 [视觉优先版式](./2026-09-19-comparison-visual-first-card.md) 的卡面顺序（自主主体区由后续包调整）。

## 验证

- `test/application/comparison-evidence.test.ts`：append-only 短引用；注册后 `ev-03` 可 assert；未知 `ev-999999` 拒绝；并发注册不丢；路径穿越 / 伪造 toolCallId / 超限失败；同 hash+参数不去重错 side；emit 失败后重试仍写出 `comparison.evidence_registered`。
- `npm run build` 后 `node --test dist/test/application/comparison-evidence.test.js`。
- 相关源码变更批次结束跑 `npm run check`。
