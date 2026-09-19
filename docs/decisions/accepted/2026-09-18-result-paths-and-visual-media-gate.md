# 决策：结果页主路径与 openable 视觉 media 门禁

状态：accepted

## 问题

TUI 结果页需要打开**文件**（报告、历史终稿、候选终稿），而不是仅打开隔离目录；Trace/Replica 降为排查。Host 对照前对 HTML 终稿无头截图写入 `facts/media.json`；双侧有视觉交付但 media 为空时必须 `media_unavailable`，不能静默发纯文本卡。历史终稿路径须与 Comparison 的 openable 发现一致（封存 finals → derived-history → case baseline-artifacts → briefing history），且只链接磁盘上存在的文件。任务起点 `environment/baselines` 不是历史终稿。

## 决定

- `buildResultPathLinks` 异步解析路径：`resolveHistoricalFinalPath` 与 `discoverOpenableSources` 共用 `historical-final-discovery.ts` 的搜索顺序与存在性检查；无匹配则不写链接。
- baseline HTML 封存到 attempt `finals/` 时，同名 basename 冲突且字节不同则失败，避免错误绑定。
- 无头截图经 `src/infrastructure/headless-screenshot.ts`；失败区分 `no_browser` 与 `capture_failed`，诊断写入 `ComparisonVisualMediaError` 消息。
- `deepseek-v4.1-flash` 不得借用 `deepseek-v4-flash` 费率；独立目录行见 [2026-09-19 价格目录同步 cc-switch](../archive/accepted-2026-09/2026-09-19-pricing-catalog-cc-switch-seed.md)。
- `fileLink` 可见文本始终是调用方短标签；`hyperlinks` 为真才发 OSC 8，为假也不改成绝对路径。跳过对照仍渲染报告 / 历史终稿 / 候选终稿行；报告仅在路径指向报告文件（不是实验根目录）时做成链接。结果页页脚列出 `o` / `h` / `f`。

## 备选方案

**只链隔离目录（runs/、environment/runs/）。** 操作者仍需自己找终稿文件；与「结果页主路径打开文件」产品要求冲突。

**为 `deepseek-v4.1-flash` 发明别名借用 v4-flash 费率。** 与 2026-09-14 定价 ADR 冲突；V4.1 与 V4 不得互借单价。

**截图失败时 catch 后返回 false、仍尝试发纯文本卡。** 双侧有视觉产物时会静默降级；门禁要求 `media_unavailable` 且带诊断。

## 影响

- TUI 结果页：`pathLinks` 提供 report / historyFinal / candidateFinal 文件路径；Trace/Replica 标签带「排查」。短标签在无 OSC 8 时仍可键盘打开，指针按 `kvLinkBlock` 结构化命中区间回退。
- Comparison：`historical-final-discovery.ts` 与 openable 管线共用发现逻辑；HTML 截图走 infrastructure 层。
- 定价：`deepseek-v4.1-flash` 使用独立目录行，不借用 V4；`verify-pack` 使用 `semverFromVersionOutput` 与 `nodeVersionAtLeast`。
- TUI 帧 `26-result` / `26b-result-compact` 须与 Windows 生成一致（见 [TUI 帧基线只在 Windows runner 上比对](2026-08-15-tui-frame-baseline-windows-only.md)）。

## 验证

- `test/application/result-paths.test.ts`：历史/候选终稿指向真实文件；缺失 baseline 时不链接；实验根目录不作报告。
- `test/tui/file-link.test.ts`：`fileLink` 在 `hyperlinks=false` 时保留短标签。
- `test/tui/result-page.test.ts`：跳过对照仍渲染历史/候选行。
- `test/tui/pointer.test.ts`：无 OSC 8 时结构化命中仍可打开；窄宽中文标签截断不误判。
- `test/application/comparison-openable-media.test.ts`：封存、成对 media 门禁。
- `scripts/verify-pack.mjs`：`semverFromVersionOutput` 与 `nodeVersionAtLeast` 自检。
- TUI 帧 `26-result` / `26b-result-compact` 反映新标签。
