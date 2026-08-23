# Project Progress Master

## Current Objective

- Current goal: 实施 [`产品优先的会话 Intake 开发计划`](../plan/product-first-session-intake.md)。
- Non-goals: 双语 i18n、决策分类子目录、per-file 100% 覆盖率、真实计费 smoke 进 CI、dependabot 的 TypeScript 大版本升级。

## Current Phase

- Phase: 产品优先 Intake / 会话发现与产品中立 TUI 已完成审计。
- Entry condition: Comparison HTML 报告改造的结果页结构已稳定；仅允许最小产品标签参数化。
- Completion condition: 产品选择、会话隔离、身份传递、文档和 TUI 审计均通过 `npm run check`。

## Completed

- [x] Comparison Agent 自由 HTML 报告优化：接受 System Prompt 行为契约；Agent 原样写入 `report.html`，Host 投影 `reportFacts`，Comparison 失败写独立降级页，删除 Markdown renderer 主路径。
- [x] 产品优先 Intake（首批）：静态 Pack 产品页、按 Pack 惰性发现与进程内缓存、隔离项目/搜索/错误、按 `productId` freeze 和 Runtime 解析，以及 Claude Code TUI 审计帧。
- [x] 会话摘要正确性：严格校验 ISO 时间；Claude 从所有事件取最早有效时间，首条元事件缺时间不再显示 epoch。
- [x] Claude 轻量发现：列表扫描不再调用完整 import，不保留 transcript、raw JSONL 或历史事件。
- [x] 产品显示首批迁移：顶栏、确认页、运行页和结果 Runtime 失败来源使用已选产品；无产品时显示 `Agent unset` / `Unknown agent`，不回退为 Codex。
- [x] 项目/root 隔离首批：legacy 单 root 仅归属一个 Pack；同 cwd 跨产品不混组，未知 cwd 不假合并。
- [x] Session discovery page：Pack port 返回分页 items、cursor、扫描/跳过诊断；cursor 绑定产品 root，TUI 以 root 缓存并支持加载更多、刷新和取消。
- [x] 全局会话时间分页：摘要 index 先以 8 并发完成轻量读取，再按 `updatedAt + sourcePath` 全局排序；cursor v2、index diagnostics 和最多 4 个 product/root/fingerprint 内存 index 保证连续页不重读 JSONL，`r` 强制重建。
- [x] 任务 1：audit lane 改到 `windows-latest`
- [x] 任务 3：`gen-docs` 正则转义，生成区非空
- [x] 任务 4：分析器接进 `check` / `audit`，修 60 列溢出
- [x] 任务 2：`DISPLAY_CWD` 改为 `C:\reprise`，重生成帧
- [x] 任务 5：`verify:docs` / `gen-docs` / 帧比对接入反向自检
- [x] 任务 6：打开 knip `exports`，删无用导出与死代码
- [x] 任务 7：抽出 TUI 审计共享实现，knip / jscpd 改为阻塞
- [x] 任务 8：门禁契约进 `engineering-gates.md`，已完成计划移出 `plan/`

## In Progress

- Current task: 产品优先 Session Intake 已完成；2026-08-16 已完成本机 Windows 11 默认根只读验收，并自动验证临时 directory junction/symlink 循环和 ACL 拒绝不会被跟随或吞掉；1,500 文件树回归作为当前 Windows 基准。TUI 会话/项目的相对时间也已接入可注入渲染时钟，帧审计不再随着真实日期漂移。完成审计另补强了快速产品切换时晚到 discovery 结果不会覆盖当前选择、以及 `excludeRoots` 不误伤相邻路径的直接回归用例。
- Owner / agent: Codex
- Related files: `src/products/contract.ts`、两个 Pack 的 `sessions.ts`、`src/products/shared/session-files.ts`、`src/tui/controller.ts`、`src/tui/view-projection.ts`、`src/tui/pages/intake.ts`、`scripts/tui-visual-audit.mjs`、产品/决策文档。

## Blocked

- Blocker: 无

## Decisions

| Date | Decision | Reason | Impact |
|---|---|---|---|
| 2026-08-15 | Comparison Agent 直接创作 `report.html` | 报告表达由同一个证据调查者负责；Host 只校验薄交付协议 | 删除 Markdown renderer 与固定成功模板 |
| 2026-08-15 | 帧基线只在 Windows 比对 | 平台相关产物，逐项注入会铺开 | audit lane |
| 2026-08-15 | 生成区输出信封字段表 | `EventEnvelope.type` 不是判别联合 | gen-docs |
| 2026-08-15 | 门禁必须附反向用例 | 干净树上退出 0 不能证明门禁在验 | 全部门禁 |
| 2026-08-14 | 覆盖率阈值取实测值，只升不降 | 避免人为缓冲允许倒退 | `test:coverage` |

## Next Actions

- 运营性复查（非实现门禁）：在真实 Windows 11 的 Claude Code 与 Codex 历史目录上按需确认产品切换不会交叉显示会话；ACL 和 junction/symlink 循环均已由隔离临时 fixture 覆盖，不创建或修改用户历史根中的 ACL 或链接。
- 如真实环境出现差异，先复用 discovery diagnostics 与 Pack root 配置定位；不要以 TUI 产品名或时间显示特判掩盖数据问题。无待开发项。

## Verification Evidence

| Time | Method | Command / evidence | Result |
|---|---|---|---|
| 2026-08-15 | Comparison HTML gate | `npm run check` | 11 通过, 0 失败；272 tests（271 pass，1 skipped） |
| 2026-08-15 | local check DAG | `node scripts/run-gates.mjs check` | 11 通过, 0 失败；含 tui analyze、knip、jscpd |
| 2026-08-15 | TUI visual audit | `npm run audit:tui:check` | 43 frames, 0 issues；含产品页和 Claude Code 项目/会话页 |
| 2026-08-15 | knip exports | `npm run knip` | exit 0 |
| 2026-08-15 | jscpd | `npm run jscpd` | 9 clones, 0.62%, threshold 1 |
| 2026-08-15 | Intake targeted tests | `node --test product-first-intake, cli, codex-intake, intake-ui` | 27/27 passed |
| 2026-08-15 | Intake full gate | `npm run check` | 11 通过, 0 失败；275 tests（274 pass，1 skipped） |
| 2026-08-16 | 全局 summary index 回归与全门禁 | `npm run build`；41 个受影响测试；`npm run check` | 41/41 passed；11 通过, 0 失败, 0 跳过；297 tests（296 pass，1 skipped）。 |
| 2026-08-16 | junction 回归与最终门禁 | `npm run build`；42 个受影响测试；`npm run verify:docs`；`npm run check` | 42/42 passed；文档检查通过；11 gates 通过，298 tests（297 passed，1 skipped）。 |
| 2026-08-15 | Intake targeted build/test | `npm run build`；`node --test dist/test/widgets.test.js dist/test/product-first-intake.test.js dist/test/intake-ui.test.js dist/test/claude-code-pack.test.js dist/test/codex-intake.test.js` | build 通过；98/98 passed。覆盖 Claude/Codex 摘要、root/project 隔离和产品中立 TUI fallback。 |
| 2026-08-15 | 产品中立 TUI 全门禁 | `npm run audit:tui:check`；`npm run check` | 43 frames, 0 issues；11 gates 通过，281 passed、1 skipped。 |
| 2026-08-15 | 流式摘要 targeted | `npm run build`；`node --test dist/test/session-discovery-page.test.js dist/test/session-summary-streaming.test.js dist/test/claude-code-pack.test.js dist/test/codex-pack.test.js` | build 通过；58/58 passed；覆盖 1,500 文件树、未知时间排序、file-mtime fallback、格式错误及超限。 |
| 2026-08-15 | 产品优先 Session Intake 最终门禁 | `npm run check` | 11 gates 通过，287 tests（286 passed，1 skipped）；含 typecheck、lint、TUI frames/analyze、generated docs、knip、jscpd。 |
| 2026-08-16 | 会话页渲染时钟、扫描回归与最终门禁 | `node --test dist/test/session-summary-streaming.test.js dist/test/session-discovery-page.test.js dist/test/product-first-intake.test.js dist/test/codex-intake.test.js dist/test/intake-ui.test.js`；`npm run audit:tui:check`；`npm run check` | 44/44 通过；43 frames、0 issues；11 gates 通过，301 tests（300 passed，1 skipped）。相对时间帧由固定注入时钟验证，不重写基线。 |`r`n| 2026-08-16 | 完成审计补强与最终门禁 | `npm run build`；`node --test dist/test/paths.test.js dist/test/product-first-intake.test.js dist/test/codex-intake.test.js dist/test/session-discovery-page.test.js dist/test/session-summary-streaming.test.js dist/test/intake-ui.test.js dist/test/widgets.test.js dist/test/claude-code-pack.test.js`；`npm run verify:docs`；`npm run check` | 121/121 通过；文档检查通过；11 gates 通过，302 tests（301 passed，1 skipped）。直接覆盖晚到 discovery 结果隔离与相邻 `excludeRoots` 路径边界。 |

## Drift / Risks

- Plan drift: dependabot 积压（含 TypeScript 7）不在本轮落地
- New dependencies: 无
- New risks: 工作区包含 Comparison/TUI 审计等并行未提交变更；result 页只能继续最小参数化，不能扩展到报告逻辑。双 Pack 结构性重复仍占 jscpd 条数；阈值只升不降。
- Replan needed: 否；剩余真实历史人工验收不改变端口或 on-disk 格式。
