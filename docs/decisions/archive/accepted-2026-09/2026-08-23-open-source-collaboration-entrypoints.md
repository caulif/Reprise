# 决策：开源协作入口放在 docs/ 与 .github/

状态：accepted

## 问题

仓库缺少面向外部贡献者的协作、安全和任务入口。GitHub 约定文件名是 `CONTRIBUTING.md`、`SECURITY.md` 等；同时[文档结构](../../documentation-structure.md)规定仓库根目录只保留 `README.md` 与 `AGENTS.md`，且 `docs/` 正文文件名默认 kebab-case。若不单独拍板，协作文件会同时违反根目录规则、命名规则，或落在 GitHub 发现不了的路径。

## 决定

协作与治理 Markdown 放在 `docs/`，使用 GitHub 能发现的文件名：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`SUPPORT.md`、`GOVERNANCE.md`、`CHANGELOG.md`。这些名字是 kebab-case 规则的显式例外，由 `scripts/verify-docs.mjs` 登记。根 `README.md` 只做入口，不复制流程正文。

Issue / PR 模板和 `CODEOWNERS` 放在 `.github/`。任务 brief 模板放在 [`docs/plan/task-brief-template.md`](../../plan/task-brief-template.md)。`npm run verify:docs` 检查这些路径存在，并检查文档或模板含有规定标记；缺少任一路径或必填标记时门禁失败。

当前唯一 CODEOWNER 是 `@caulif`。不引入审批机器人或委员会。

## 备选方案

**把治理文件放在仓库根目录。** GitHub 与 npm 习惯如此，但会打破根目录只保留 `README.md` 与 `AGENTS.md` 的规则，并让文档门禁无法用同一套目录模型约束。

**全部使用 kebab-case（如 `docs/contributing.md`）。** 与现有命名一致，但 GitHub 社区标准检查与 Security Policy 入口不会自动识别。

**引入 CODEOWNER team、必审 bot 或治理委员会。** 当前是单维护者项目，额外流程没有对应的人来执行。

## 影响

- 新贡献者路径是 README → `docs/CONTRIBUTING.md` → 子树 `AGENTS.md`。
- 安全报告走 GitHub Security Advisory，不要求公开 Issue。
- 文档命名例外增加了门禁要维护的白名单；白名单只覆盖上述 GitHub 约定文件。

## 验证

- `docs/` 下存在本节列出的六个治理文件；`.github/` 下存在 PR 模板、三个 Issue 模板和 `CODEOWNERS`。
- `npm run verify:docs` 在缺少这些路径或必填标记时退出非 0；自检覆盖这一失败。
