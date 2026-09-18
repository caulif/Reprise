# 决策：结果页主路径与 openable 视觉 media 门禁

状态：accepted

## 问题

TUI 结果页需要打开**文件**（报告、历史终稿、候选终稿），而不是仅打开隔离目录；Trace/Replica 降为排查。Host 对照前对 HTML 终稿无头截图写入 `facts/media.json`；双侧有视觉交付但 media 为空时必须 `media_unavailable`，不能静默发纯文本卡。历史终稿路径须与 Comparison 的 openable 发现一致（封存 finals → briefing history → baseline-artifacts → baselines），且只链接磁盘上存在的文件。

## 决定

- `buildResultPathLinks` 异步解析路径：`resolveHistoricalFinalPath` 与 `discoverOpenableSources` 共用 `historical-final-discovery.ts` 的搜索顺序与存在性检查；无匹配则不写链接。
- baseline HTML 封存到 attempt `history/finals/` 时，同名 basename 冲突且字节不同则失败，避免错误绑定。
- 无头截图经 `src/infrastructure/headless-screenshot.ts`；失败区分 `no_browser` 与 `capture_failed`，诊断写入 `ComparisonVisualMediaError` 消息。
- `deepseek-v4.1-flash` 仍按 [2026-09-14 对照定价快照](../archive/accepted-2026-09/2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md) 保持 `miss`，不借用 `deepseek-v4-flash` 费率。

## 备选方案

**只链隔离目录（runs/、environment/runs/）。** 操作者仍需自己找终稿文件；与「结果页主路径打开文件」产品要求冲突。

**为 `deepseek-v4.1-flash` 发明别名借用 v4-flash 费率。** 与 2026-09-14 定价 ADR 冲突；V4.1 与 V4 不得互借单价。

**截图失败时 catch 后返回 false、仍尝试发纯文本卡。** 双侧有视觉产物时会静默降级；门禁要求 `media_unavailable` 且带诊断。

## 影响

- TUI 结果页：`pathLinks` 提供 report / historyFinal / candidateFinal 文件路径；Trace/Replica 标签带「排查」。
- Comparison：`historical-final-discovery.ts` 与 openable 管线共用发现逻辑；HTML 截图走 infrastructure 层。
- 定价：`deepseek-v4.1-flash` 继续 `miss`；`verify-pack` 使用 `semverFromVersionOutput` 与 `nodeVersionAtLeast`。
- TUI 帧 `26-result` / `26b-result-compact` 须与 Windows 生成一致（见 [TUI 帧基线只在 Windows runner 上比对](2026-08-15-tui-frame-baseline-windows-only.md)）。

## 验证

- `test/application/result-paths.test.ts`：历史/候选终稿指向真实文件；缺失 baseline 时不链接。
- `test/application/comparison-openable-media.test.ts`：封存、成对 media 门禁。
- `scripts/verify-pack.mjs`：`semverFromVersionOutput` 与 `nodeVersionAtLeast` 自检。
- TUI 帧 `26-result` / `26b-result-compact` 反映新标签。
