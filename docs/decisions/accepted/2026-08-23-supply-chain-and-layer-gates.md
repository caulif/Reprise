# 决策：发布包、依赖审计、secret 与分层 import 进入门禁

状态：accepted

## 问题

`prepublishOnly` 只跑 `check`，CI 不检查 npm 包内容、production 漏洞、跟踪文件中的令牌形态，也不检查 `src/` 分层 import。外部贡献者和发布者无法在合并前发现把测试、文档或密钥打进包，或 core 依赖 TUI。

## 决定

`scripts/verify-pack.mjs`、`verify-audit.mjs`、`verify-secrets.mjs`、`verify-layer-imports.mjs` 进入 `run-gates.mjs` 的 `static` 与 `check`。`verify:pack` 必须 `needs: ['build']`，不得与 `rm dist` 并行。包检查同时拒绝 allowlist 之外的路径，并要求 `package.json`、`README.md`、`LICENSE`、`package.json.bin.reprise` 指向的文件（当前为 `dist/src/cli/main.js`）以及至少一个 `dist/src/` 文件存在。每个脚本启动时跑自检：坏包路径、空壳包、缺 bin 包、高危 audit、令牌样本、core→tui import 必须失败。真实 Runtime smoke 仍不在默认 CI。production audit 始终解析 `npm audit --json` 的 stdout，即使子进程非零；仅当 `productionAuditFailed` 为 true（high/critical）时失败。secret 扫描覆盖工作区 tracked/未跟踪文本（`readFileSync`）以及 `git diff --cached --diff-filter=ACMR` 对应的 **index blob**（`git show :<path>`），包括 `test/`；finding 标明 `index` 或 `working-tree`，只输出路径、来源和规则名。分层 import 识别 `from`、`export ... from` 和 `import()`。

## 备选方案

**只在发布人笔记本上手工 `npm pack`。** 没有反向用例，包内容会在无人注意时膨胀。

**CI 跑完整 `npm audit`（含 dev）。** 会把 ESLint 等开发工具 CVE 变成合并阻断，与运行时风险不成正比。

**引入独立 SCA SaaS。** 当前依赖面很小，先用 npm audit 与包 allowlist。

## 影响

- 本地 `npm run check` 增加 pack dry-run 与 audit 时间。
- 高危 production 漏洞会阻断合并，直到升级或另写带 CVE 的 decision。

## 验证

- `node scripts/verify-pack.mjs --self-test` 以及其余三个脚本的 `--self-test` 退出 0。空壳三文件包与 bin 指向缺失文件必须在自检中失败。
- `node scripts/run-gates.mjs --self-test` 断言 `verify:pack` 依赖 `build`。
- 干净树 `node scripts/run-gates.mjs static` 包含这四个 id。
