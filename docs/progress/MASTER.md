# Project Progress Master

## Current Objective

- Current goal: 按 [`docs/plan/agent-oriented-engineering-optimization.md`](../plan/agent-oriented-engineering-optimization.md) 逐方面落地面向 Agent 协作的工程化优化。
- Non-goals: 双语 i18n、决策分类子目录、per-file 100% 覆盖率、真实计费 smoke 进 CI、全面重构 controller/experiment、lefthook。

## Current Phase

- Phase: 方面 0–L 已完成
- Entry condition: 方面 A 已完成；工作树含未受控 docs 重构与源码变更。
- Completion condition: 方面 0–L 全部验收通过；`git status --porcelain` 行数为 0。

## Completed

- [x] 方面 A：文档体系与受控边界
- [x] 方面 0：修复构建，挂 `smoke:claude`
- [x] 方面 B：分层 AGENTS.md / CLAUDE.md
- [x] 方面 C：`verify-docs.mjs` 与字符预算
- [x] 方面 D：TUI 帧 `--check` 基线（41 帧）
- [x] 方面 I：拆分 `controller.ts` / `experiment.ts`，`src/` 无 ≥1200 行文件
- [x] 方面 H：Agent 可见输出快照
- [x] 方面 J：`formatBytes` / `writeAtomic` 去重；knip / jscpd 观察模式
- [x] 方面 G：schema 生成文档区
- [x] 方面 E：`run-gates.mjs` 编排 `check`
- [x] 方面 F：覆盖率阈值 88 / 76 / 87（2026-08-14 实测向下取整）
- [x] 方面 K：CI 四 lane + `all-checks-passed`
- [x] 方面 L：按主题提交

## In Progress

- Current task: 无
- Owner / agent: —
- Related files: —

## Blocked

- Blocker: 无

## Decisions

| Date | Decision | Reason | Impact |
|---|---|---|---|
| 2026-08-14 | 门禁脚本用 `.mjs`，不引入 `tsx` | 零新增运行时依赖 | C/D/E 全部门禁 |
| 2026-08-14 | 覆盖率阈值取当前实测值，只升不降 | 避免人为缓冲允许倒退 | 方面 F；记录见[覆盖率阈值](../decisions/accepted/2026-08-14-coverage-thresholds.md) |
| 2026-08-14 | `AGENTS.md` 用中文，预算按字符数 | 中文无空白分词 | 方面 B/C-5 |

## Next Actions

- 无。本计划已收口。

## Verification Evidence

| Time | Method | Command / evidence | Result |
|---|---|---|---|
| 2026-08-14 | live Claude e2e (start rewind) | `REPRISE_RUN_CLAUDE_E2E=1` `scripts/claude-real-e2e.ts` | exit 0; 255s; report `historical_start`; `default` → `deepseek-v4-flash[1m]`; 1 turn; 2 files; `completed.controller_satisfied`; `comparison.md` 写出；标题/表已渲染 |
| 2026-08-14 | coverage floors | `npm run test:coverage` | 276 pass / 1 skip；总体 88.08 / 76.54 / 87.48；阈值 88 / 76 / 87 退出 0 |
| 2026-08-14 | TUI baseline | `node scripts/tui-visual-audit.mjs --check` | 41 帧逐字节一致，退出 0 |
| 2026-08-14 | docs gate | `node scripts/verify-docs.mjs` | `verify-docs: ok` |
| 2026-08-14 | local check DAG | `node scripts/run-gates.mjs check` | 9 通过, 0 失败, 0 跳过, 23.5s；knip 观察、jscpd 观察 |

## Drift / Risks

- Plan drift: 方面 G 计划建议延后，按「全部改完」一并落地；`EventEnvelope.type` 不是判别联合，生成区改为信封字段表
- New dependencies: `knip`、`jscpd`（devDependency，观察模式）
- New risks: knip 只观察未使用文件/依赖；jscpd 仍会报告双 Pack 的结构性重复
- Replan needed: 否
