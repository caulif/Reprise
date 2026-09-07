# 工程门禁

本地全量入口是 `npm run check`，编排在 [`scripts/run-gates.mjs`](../scripts/run-gates.mjs)。CI 分 lane 的入口在 [`.github/workflows/check.yml`](../.github/workflows/check.yml)。不要在文档里复述门禁 id 列表——以这两个文件为准。

## 怎么跑

| 意图 | 命令 |
|---|---|
| 改源码后的本地全量 | `npm run check` |
| 只改文档 | `npm run verify:docs` |
| 只跑某一 lane | `node scripts/run-gates.mjs <mode>`，mode 为 `docs` / `check` / `static` / `test` / `audit` |
| 覆盖率 | `npm run test:coverage`（CI 单独 lane；本地 `check` 不跑） |

`test` 读的是 `dist/`。改完源码必须先 `npm run build`。

## 各类检查验什么

- **静态**：`tsc --noEmit`、eslint、文档链接与预算、schema 生成区。
- **测试**：`dist/test/**/*.test.js` 与 CLI `--version`。平台矩阵由上述 CI workflow 拥有；模拟测试不构成真实 Runtime 或 TUI 的支持承诺，见[支持边界](./SUPPORT.md)。
- **TUI 帧**：Windows 上逐字节比对 [`docs/tui-audit/frames/`](./tui-audit/frames/)，再跑启发式分析（行宽溢出、面板错位、compact 禁用字符）。基线是 Windows 产物，见[帧基线决策](./decisions/accepted/2026-08-15-tui-frame-baseline-windows-only.md)。
- **覆盖率**：总体 lines / branches / functions 阈值，见[覆盖率决策](./decisions/accepted/2026-08-14-coverage-thresholds.md)。
- **未使用导出与重复**：`knip` 与 `jscpd` 进入 `check`；失败即红。`jscpd` 的 `--threshold` 是棘轮，只降不升；剩余条数来自两个 Pack 实现同一份契约，不靠忽略清单消音。
- **供应链与边界**：`verify-pack`、`verify-audit`、`verify-secrets`、`verify-layer-imports`、`verify-source-size`、`verify-tracked-source` 进入 `static`/`check`。各自带 `--self-test` 反向用例。真实 Runtime smoke 仍不在默认 CI。`src/**/*.ts` 与 `test/**/*.ts` 文件超过 1000 行、`src/**/*.ts` 函数/方法跨度超过 100 行且未在 [`scripts/source-size-allowlist.json`](../scripts/source-size-allowlist.json) 登记，或例外已到期，门禁失败。`src/` 与 `test/` 不得有被 Git 忽略的 TypeScript；受控源码的相对导入目标必须受 Git 控制；ESLint ignore 以实际配置解析为准，不得覆盖受控 `src/`/`test/` TypeScript；`tsconfig.exclude` 不得列出 `src/` 或 `test/` 路径。见[函数长度与受控源码](./decisions/accepted/2026-08-25-source-size-functions-and-tracked-source.md)。

## 门禁必须能失败

新增或修改门禁时，同一次变更必须附一个能让该门禁失败的自动化用例。只验证干净树上退出 0，不构成门禁生效的证据。见[反向用例决策](./decisions/accepted/2026-08-15-gate-reverse-tests.md)。

覆盖率阈值只能升不能降；不能用文档例外绕过门禁。

失败日志必须能用来复现：gate id、完整命令、退出码或 spawn 错误、Node/OS/git SHA。`node scripts/run-gates.mjs --self-test` 故意失败以证明这些字段存在。没有非阻断 gate。

不要为了绿灯放宽阈值、给检查加例外、或把失败项改成非阻断。
