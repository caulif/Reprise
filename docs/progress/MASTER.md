# Reprise 重构进度

## 未关闭验收

- 真终端、Runtime smoke、Controller 真实模型 lane 与生产模型输入对拍统一见[证据矩阵](../plan/2026-09-08-platform-evidence-matrix.md)。
- [N6 Recovery+Controller 新复刻验收](../plan/2026-09-16-share-card-and-n6-replay.md)保持 OPEN：尚无显式 opt-in 新跑的完整通过证据；任务前 baseline 与无未见建议的开场须同时核对，旧 sink、旧轨迹或重渲染卡面不能替代。
- Recovery 默认空 staging 目标见[最小 Host](../plan/recovery-agent-minimum-host.md#91-provider从整树播种改为空-staging)；当前 [beginRecovery](../../src/environment/local-workspace-provider.ts) 仍复制预算内 source 或 checkpoint，超预算才使用 sparse。
- Recovery 基线复用前的运行条件检查与缺失条件修补仍须验证，见[起点恢复目标](../plan/recovery-initial-environment.md)。

## 最近完成证据

2026-09-18 OSS P0 本地路径只向前修：`claude-real-e2e` 改由 `REPRISE_CLAUDE_REAL_E2E_SESSION` 注入；`verify-secrets` 拒绝 `src/`/`scripts/`/`test/` 内真实形态本机绝对路径。见[决策](../decisions/accepted/2026-09-18-oss-local-path-forward-fix.md)。

2026-09-18 文档计划出清（Phase B）：`docs/plan/` 活跃文件压至 5 份；历史目标与迁移表迁入 `docs/plan/archive/`。`npm run verify:docs` 退出 0。范围仅文档与导航，未运行代码门禁或付费验收。

2026-09-17 文档与协作流程（Phase 0–4）：计划目录从 42 份收敛为 8 份开放目标与 1 份模板；立场见[轻量流程决策](../decisions/accepted/2026-09-17-docs-workflow-solo-to-oss.md)。

## 更新约定

只保留未关闭项与可复核短证据。当前规范以[架构总览](../architecture/overview.md)与[产品定义](../product/overview.md)为准。没有证据不标为完成。
