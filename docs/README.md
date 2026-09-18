# Reprise 文档

当前事实在 product/ 与 architecture/，未关闭目标在 plan/，选择理由在 decisions/。先确定任务是当前修复还是目标迁移；文件日期不决定权威。

## 开源 30 分钟路径

首次了解 Reprise（贡献者或 coding agent）按此顺序阅读即可开工，**不必通读** architecture 专题全文，也**不必通读** `decisions/accepted/` 下的 ADR：

1. [根 README](../README.md) — 从源码构建与使用边界
2. 本文 — 导航与「不要读什么」
3. [产品定义](./product/overview.md) — 问题、主路径、安全与凭据
4. [架构总览](./architecture/overview.md) — 跨模块唯一规范入口
5. [日常开发](./development.md) — 本地命令与验证

需要 TUI 操作时再读 [TUI 说明](./product/tui.md)；需要贡献时再读 [CONTRIBUTING](./CONTRIBUTING.md) 与 [门禁契约](./engineering-gates.md)。ADR 与 plan 仅在任务触及时按需检索，不是前置必读。

## 按模块阅读

深入某一模块时再用下表；它不是 30 分钟路径的前置清单。

| 模块 | 当前规范 | 工程或专题入口 |
|---|---|---|
| 产品与安全 | [产品定义](./product/overview.md) | [TUI 操作](./product/tui.md) |
| 跨模块生命周期 | [架构总览](./architecture/overview.md) | [角色与 prompt](./architecture/agent-roles-and-system-prompts.md) |
| 持久化与 CandidateRun | [持久化](./architecture/persistence-and-crash-consistency.md) | [结果与终止](./architecture/run-outcome.md) |
| Recovery / 环境 | [环境](./architecture/environment.md) | [最小验证边界](./architecture/overview.md#附录最小验证边界) |
| Controller | [Controller](./architecture/controller.md) | — |
| Comparison | [对照](./architecture/comparison.md) | — |
| Product Pack / 平台 | [平台与 Pack](./architecture/platform-and-packs.md) | — |
| 日常开发 | [开发环境与验证](./development.md) | [按改动跑门禁](./cookbook/verify-change.md) |
| 贡献与维护 | [贡献指南](./CONTRIBUTING.md) | [治理](./GOVERNANCE.md)、[门禁契约](./engineering-gates.md) |
| 文档维护 | [文档结构](./documentation-structure.md) | [文档指令](./AGENTS.md)、[写 ADR](./cookbook/add-adr.md) |

## 不要读什么

### 默认不要通读（按需检索）

`decisions/accepted/` 是受控的现行规则归档，但约两百份 ADR **不是**默认通读清单。先读 [decisions/README](./decisions/README.md) 的触发与检索说明；任务触及时再 `git grep` 打开单篇。

| 路径 | 说明 |
|---|---|
| `docs/decisions/accepted/` 全文 | 因果层归档；单篇 ADR 在触发时按需打开，不必前置通读 |

### 非规范 / 不进 git

以下路径**不是**现行规范或日常读物；多数已忽略，公开检出通常不存在：

| 路径 | 说明 |
|---|---|
| `docs/tui-audit/frames/` | **CI 门禁基线**（`audit:tui` 逐字节比对），不是 UI 设计文档；改动 TUI 渲染后由脚本重新生成并提交 |
| `docs/.local/` | 本机一次性审查与已结束计划；受控文档不得链接 |
| `docs/local/` | `docs/.local/` 的历史误拼路径，已在 `.gitignore` 忽略；以 `docs/.local/` 为准 |
| `docs/analysis/`、`docs/research/`、`docs/tui-loop/`、`docs/evidence/` 等 | 本机实验与证据产物，已忽略，不进 git |
| `docs/tui-full-flow/`、`docs/tui-intake-review/`、`docs/tui-live-run/` | TUI 验收脚本输出目录，已忽略 |

## 开放目标与证据

[MASTER](./progress/MASTER.md)集中列出开放目标与短证据；[平台矩阵](./plan/2026-09-08-platform-evidence-matrix.md)区分 CI、真终端和授权 Runtime 验证。目标计划不是已交付能力，文档清理不能关闭尚缺的真人或付费验证。

决策触发、生命周期与搜索见 [decisions/README](./decisions/README.md)（按需检索，非通读清单）。公开检出仅依赖受控文档，不依赖本机草图或归档。
