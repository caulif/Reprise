# 决策：结果页主路径与 openable 视觉 media 门禁

状态：accepted

## 问题

TUI 结果页需要打开**文件**（报告、历史终稿、候选终稿），而不是仅打开隔离目录；Trace/Replica 降为排查。Host 对照前对 HTML 终稿无头截图写入 `facts/media.json`；双侧有视觉交付但 media 为空时必须 `media_unavailable`，不能静默发纯文本卡。历史终稿路径须与 Comparison 的 openable 发现一致（封存 finals → briefing history → baseline-artifacts → baselines），且只链接磁盘上存在的文件。

## 决定

- `buildResultPathLinks` 异步解析路径：`resolveHistoricalFinalPath` 与 `discoverOpenableSources` 共用 `historical-final-discovery.ts` 的搜索顺序与存在性检查；无匹配则不写链接。
- baseline HTML 封存到 attempt `history/finals/` 时，同名 basename 冲突且字节不同则失败，避免错误绑定。
- 无头截图经 `src/infrastructure/headless-screenshot.ts`；失败区分 `no_browser` 与 `capture_failed`，诊断写入 `ComparisonVisualMediaError` 消息。
- `deepseek-v4.1-flash` 仍按 [2026-09-14 对照定价快照](../archive/accepted-2026-09/2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md) 保持 `miss`，不借用 `deepseek-v4-flash` 费率。

## 验证

- `test/application/result-paths.test.ts`：历史/候选终稿指向真实文件；缺失 baseline 时不链接。
- `test/application/comparison-openable-media.test.ts`：封存、成对 media 门禁。
- `scripts/verify-pack.mjs`：`semverFromVersionOutput` 与 `nodeVersionAtLeast` 自检。
- TUI 帧 `26-result` / `26b-result-compact` 反映新标签。
