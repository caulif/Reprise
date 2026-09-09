# 按业务所有权归组

本文写**怎么把现有模块按所有者收拢**，不改实验生命周期、Pack 契约或 TUI 交互语义。目标仍是[架构重构](./reprise-architecture-redesign.md)与[Session harness workflow](../decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)。界面页图以[产品 TUI](../product/tui.md)为准；本计划不重做[界面重构](./reprise-tui-surface-refactor.md)。

进一步审查已要求用所有权边界压缩入口，而不是再铺一层通用抽象，见[进一步审查](./2026-09-08-further-architecture-refactoring-review.md)第 3.5 节。依赖方向仍以[代码层指令](../../src/AGENTS.md)为准。

进度记在 [MASTER](../progress/MASTER.md)。开工第一批时把当前批次改成本文对应节；未开工不把归组标成进行中。

## 完成判据

改一个业务能力时，实现、测试与入口落在**同一所有者附近**；跨模块只经公开操作，而不是共享可变实例或中心再导出。验收看集中度与可发现性，**不把文件数减少或单文件行数降低当作成功**。

本文件写于 2026-09-08 的静态结构分析：未按本文搬文件，也未用本文替代全套门禁。当时工作区约 173 个 `src/**/*.ts`；`application` 与 `tui` 文件最多。清点会漂移，以当时目录为准，不在后文复述文件表。

## 不做

- 不把大文件切成更多无所有权的小文件。
- 不立刻重排全部顶层目录（`cli` / `agents` / `environment` / `products` 按现有边界保留，除非某批明确搬迁）。
- 不引入状态管理库、DI 容器或新的 workflow engine。
- 不把 `state-machine.ts` 悄悄搬走：根 [AGENTS.md](../../AGENTS.md) 要求 CandidateRun 状态变化只经 `src/core/state-machine.ts` 的 `assertTransition`；移动必须同批改约束、调用方与架构测试。
- 不机械重命名 `products/codex/` 与 Codex 专属测试里的产品名。
- 不单独大搬家 `test/` 或 `scripts/`；测试与脚本随业务批次走。
- 不另建 archive 或第二套总计划目录；文档生命周期继续按[文档结构](../documentation-structure.md)。
- 不在本计划关闭真终端、付费 Controller lane 或 Runtime smoke。

## 约束

- 层间依赖：`cli` → `tui` → `application` → `infrastructure` / `products` / `environment` / `agents` / `report` → `core`。
- `tui/pages/` 只渲染。
- 持久化与外部 JSON 仍过 `src/core/schema.ts` 的 `Value.Check`（拆 schema 时兼容导出保留到迁移结束）。
- 每新增一条所有权门禁，同批附能失败的[反向用例](../decisions/accepted/2026-08-15-gate-reverse-tests.md)。
- 目录示意不是必须一次创建的文件清单：已有 helper 能承接的合并；仅一个调用方的小函数留在调用方。

## 批次

| 批次 | 出口 | 主要改动 | 验证 |
|---|---|---|---|
| O1 所有者先于搬家 | 活动身份、取消与参数职责有单一应用所有者 | 对照[进一步审查](./2026-09-08-further-architecture-refactoring-review.md)未关闭的 F 项；CLI/TUI 只订阅，不推导 `operationId` | 现有 `experiment-activity` / `control-ipc` / CLI 协议测试；缺口才补反向用例 |
| O2 去掉空转发 | 调用方直接导入所有者 | 删除 TUI/application 空转发桶；通用类型用产品中立名，产品专属名留在 `products/codex/` | `architecture`、CLI/TUI 入口测试；禁止别名回归 |
| O3 Recovery 归组 | Recovery 流程可沿一条目录走完 | `application/recovery/` 按审计、失败分类、评估、checkpoint、受控写入、diff、调查材料分文件；角色判断仍在 [`agents/recovery-agent.ts`](../../src/agents/recovery-agent.ts) | Recovery 相关测试随路径更新 |
| O4 收缩 experiment 入口 | 没有「凡事经 experiment.ts」 | 调用方改引真正模块；[`experiment.ts`](../../src/application/experiment.ts) 只保留执行装配与本文件拥有的类型 | import 图与 `architecture` 测试 |
| O5 TUI 状态权限 | 函数不能改无关实例字段 | 配置 / 来源 / 时间线用明确参数；最外层只导航、终端生命周期、调用 Workflow。先缩可变状态，再考虑 `tui/config|intake|history|timeline|terminal/`。`pages/` 保持纯渲染 | `page-input`、intake、workflow 测试；不把 `.call(this)` 换目录当完成 |
| O6 执行机制与 schema | Agent 执行可辨认；schema 按概念拆 | `infrastructure/agent/`：Host、模型调用、压缩、输入记录、历史读取、失败分类、可见内容。`core/schemas/` 按 TaskCase / Run / Event / Recovery / Scene 拆，`schema.ts` 过渡再导出。本批**不**同时搬 `agents/` | Host / 模型输入测试；`Value.Check` 入口不丢 |
| O7 门禁、测试目录、文档 | 约束表达所有权 | 在现有架构测试上加：执行机制不导入实验业务；Pack 不导入 TUI/编排；页面不导入运行操作；应用不深层导入具体 Pack；只读查询不经会启动 Runtime 的装配入口。测试可按 `test/recovery/` 等随批移动，核对 fixture 与脚本路径。`scripts/` 仅在有维护收益时按门禁 / 评估 / smoke / TUI 审计分组 | `npm run check`；每条新约束一条反向用例 |

O1 未关闭前不开始 O3–O6 的目录搬家。O5 不与 O3 抢同一批 import 图。O6 的 `state-machine` 若迁出 `core/`，单独成批并改 AGENTS。

## 目标形状（示意）

application 先在现有顶层内归组，示例：

```text
application/
├── experiment-workflow.ts
├── experiment-operations.ts
├── recovery/
├── candidate/
├── controller/
├── comparison/
├── history/
└── control/
```

TUI 在状态权限收紧之后才整理目录，示例：

```text
tui/
├── app.ts
├── navigation.ts
├── config/
├── intake/
├── history/
├── timeline/
├── pages/
└── terminal/
```

`products/` 继续按产品组织。`cli/` 不再细分。

## 门禁缺口

[`verify-layer-imports.mjs`](../../scripts/verify-layer-imports.mjs) 用层级数字拦反向依赖；同级的 `agents`、`products`、`environment`、`infrastructure` 互引不受这条规则禁止。所有权限制写进现有 `architecture` 测试，不另起规则框架。

## 文档与根目录复审报告

受控文档继续放在 `docs/` 现有目录。根目录 `工程开发规范整改*.md` 未被受控文档引用；归档前先搜引用，无引用则移出跟踪（本地可放 `docs/.local/`），不新建平行总计划。

## 风险

- 只改路径、不改 `this` 可见字段，会把耦合换目录。O5 以参数面为出口。
- `experiment.ts` 与 `CodexIntakeTui` 被脚本和测试点名；O2/O4 必须改全调用方，禁止留下第二套入口。
- schema 拆文件期间两套导出并存，禁止业务实现长期只经兼容桶绕过所有者。
