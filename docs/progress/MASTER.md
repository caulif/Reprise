# Project Progress Master

## Current Objective

- Current goal: 依据 `FIRST-PRINCIPLES-REVIEW.md`、`OPTIMIZATION-REVIEW.md` 与 `REVIEW-ROUND-3.md`，将 Reprise 收敛为 local-first 的单候选重放与检视 Harness；只保留能提升真实契约、证据诚实性和可维护性的最小实现。
- Non-goals: 历史 commit checkout/replay、Recovery Agent、通用 benchmark CLI、额外权限抽象、动态插件、排名或胜负结论、多候选泛化、未获确认的真实 provider/Codex smoke。

## Current Phase

- Phase: 第四轮收敛完成。
- Entry condition: Round 3 已完成，核心 fidelity 伪字段已移除，剩余问题集中于平行 CLI、测试发现、脚本漂移和工程化。
- Completion condition: 单一 TUI 生产入口、自动测试发现、脚本类型检查、agent-tools 边界测试与双平台 CI 均有实现，并保有新鲜完整验证证据。

## Completed

- [x] 保留单一 `CandidateRun` 生命周期；Controller 与 Comparison 通过 Host 管理的真实 Agent session 执行，实际权限边界由注册工具白名单强制。
- [x] 删除 Recovery Agent 和不兑现的恢复语义；重放诚实地从用户所选目录的当前状态开始，并在 preflight/report 中标示该限制。
- [x] 修复 TUI 时间线以读取真实生产 payload；删除收缩后留下的 schema、capabilities 和恒等配置残留；启用 unused 检查。
- [x] 修复 CandidateRun/Codex app-server/ExperimentStore 的超时、进程关闭和 stale lock 契约；`CodexTextCaller` 对 Host tools 显式失败。
- [x] 删除核心 `RunRecord`/preflight 的硬编码 fidelity 伪分级，保留产品专属的人工 smoke acceptance 字段。
- [x] 删除 `src/cli/commands.ts`、fixture CLI 编排和 `ScriptedRuntime`；CLI 只保留 `--help`、`--version` 与直接启动 TUI 的 `--data-dir`/`--sessions-dir` 参数。
- [x] 删除手工 `test/index.test.ts` 聚合，`npm test` 改用 Node 的 `dist/test/*.test.js` 发现；构建前清除旧 `dist`，避免历史输出被误跑。
- [x] 新增 `test/agent-tools.test.ts`：覆盖路径样式输入、非 catalog artifact 和 `maxBytes` 边界；`read_artifact` 对显式非法 `maxBytes` 直接拒绝。
- [x] `local-history` 以 `access` 探测报告，并只将 ENOENT 视为缺失；artifact manifest 枚举改为 TypeBox 完整校验。
- [x] 将正式 Codex protocol smoke 改为 `scripts/*.ts` 并纳入 TypeScript；它明确是 tool-less app-server 探针，不再伪装为完整 Controller/Comparison 实验。
- [x] 新增 `.github/workflows/check.yml`，在 Windows 和 Ubuntu 的 Node 22.19.0 上执行 `npm ci` 与 `npm run check`。

## In Progress

- none。

## Blocked

- Blocker: none。

## Decisions

| Date | Decision | Reason | Impact |
|---|---|---|---|
| 2026-08-13 | 不实现 historical commit checkout/replay | `historicalCommit` 只能作为证据，不能证明任务真实起点；修改用户源码目录会伪造恢复能力 | 报告展示历史与当前 Git 事实，preflight 明确 current-state 限制 |
| 2026-08-13 | 移除 `capabilities`，只审计 `toolNames` | 工具列表才是实际白名单；声明字段既不执行又可能与工具错配 | 权限模型更小，审计仍可核查实际注册工具 |
| 2026-08-13 | 删除手工 fixture CLI 而非迁移 | 它是第二套持久化/编排与影子策略；确定性测试已直接覆盖 `CandidateRun` 与实验应用 | CLI 回到 TUI 单入口，`ScriptedRunner` 仅保留给测试 |
| 2026-08-13 | Codex smoke 收缩为 tool-less 协议探针 | app-server 无法安全暴露 Host tools，不能将其表述为完整 Harness smoke | 明确脚本边界，完整实验仅经 TUI + Pi Harness 运行 |
| 2026-08-13 | 不运行真实 provider/Codex smoke | 会产生外部调用与成本；本轮无此授权 | 静态检查、确定性测试和 CI 覆盖本地变更，真实协议验证仍需显式 opt-in |

## Verification Evidence

| Time | Method | Command / evidence | Result |
|---|---|---|---|
| 2026-08-13 | Static check | `npm run typecheck -- --pretty false` | passed（CLI、scripts、agent tools 收敛后） |
| 2026-08-13 | Focused source tests | TS source loader 下 `agent-tools`、baseline、CLI、store、experiment、Codex pack tests | 31 passed, 0 failed |
| 2026-08-13 | Reference audit | `rg` 检查删除的 CLI / `ScriptedRuntime` / `.mjs` smoke / 手工 test index 引用 | 无生产或测试引用 |
| 2026-08-13 | Patch integrity | `git diff --check` | passed |
| 2026-08-13 | Full build and automatic test discovery | `npm test` | passed（80 passed, 0 failed；构建一次后执行 `dist/test/*.test.js`） |
| 2026-08-13 | CLI artifact check | `node dist/src/cli/main.js --version` | passed（`reprise 0.1.0 (Node.js 24.11.1)`） |
| 2026-08-13 | Final patch integrity | `git diff --check` | passed |

## Drift / Risks

- Plan drift: 工作区已有大量未提交、部分未跟踪的集成改动；不执行 reset、clean、`git add -A`、提交或 push。
- New dependencies: none。
- Verification boundary: 真实 provider/Codex smoke 未运行；它需要用户明确 opt-in，并可能产生外部调用费用。
- Historical retained scripts: `scripts/codex-real-historical-c.mjs` 仍是未跟踪的本地历史产物，不在 package scripts 或 TypeScript include 中；本轮不擅自删除。
