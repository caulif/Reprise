# 决策：历史交付封存布局与 attempt 派生产物

状态：accepted

## 问题

Comparison 与 TUI 需要同一份可打开的历史终稿来源。旧 Case 在 `freezeCase` 复用路径下不会重写；仅改新导入无法补证。attempt 工具挂载把 `history/` 指到 Controller 过程目录，遮住了原先写在 `history/finals/` 的封存文件，导致 TUI 可解析而 Comparison `read` 不可见。

## 决定

- 新 Case：在隐私脱敏之后、分配 `caseId` 之后，通过 Pack 可选 `extractHistoricalArtifacts` 回调提取规范化产物；`freezeCase` 只接收类型化回调，shared freeze 不 import registry、不按 `productId` 分支。
- 落盘：`baseline-artifacts/manifest.json` + `baseline-artifacts/files/<bundleId>/<logicalPath>`；`CaseArtifactRef.caseId` 必须是真实 caseId。
- 旧 Case：新 comparison attempt 在简报前调用 `prepareHistoricalArtifacts`；有合法 case manifest 则核 hash 复用；否则从**已冻结** transcript/events 提取到 attempt `derived-history/`，不写回旧 Case，不重新 import 实时会话。
- 发现：manifest 的 artifactId / logicalPath / bundle 优先；同名 basename 多候选视为歧义，不挑第一个。`environment/baselines` 仅作任务起点，不得自动当作历史终稿。
- 挂载：保留 `history/` 为历史过程；新增只读 `finals/`（及 `REPRISE_FINALS_ROOT`）指向本 attempt 的冻结/派生产物根。封存 openable 写到 `attemptRoot/finals/`，工具路径为 `finals/...`。

## 备选方案

**覆盖旧 case.json / baseline-artifacts 补字段。** 破坏历史事实不可变；拒绝。

**继续把终稿放在 `history/finals/`。** 与 Controller history 挂载同名冲突；工具永远读不到 attempt 本地封存。

**在 ComparisonAgent / briefing 内 import Codex Pack。** 违反产品解析在 Pack、application 只走公共端口。

## 影响

- 第三方 Pack 可不实现 `extractHistoricalArtifacts`，仍可加载；缺失时 prepare 记录 `extractor_unavailable`，比较可继续基于现有证据。
- Recovery 封存起点仍是任务输入 baseline，不混入历史终稿。
- 与 [结果页路径与视觉 media 门禁](2026-09-18-result-paths-and-visual-media-gate.md) 的搜索顺序对齐：终稿证据优先封存/派生产物与 case artifacts，不再把 env baselines 当终稿。

## 验证

- `test/application/b2-historical-freeze-discovery.test.ts`：freeze 封存、reuse 哈希不变、prepare 派生、basename 歧义、env baselines 降级、`finals/` 挂载可读。
- `test/application/historical-final-discovery.test.ts`：与 case artifacts 一致解析；attempt finals 优先。
- `test/application/comparison-tracks.test.ts`：INDEX 含 `finals/`。
