# 开发与验证

## 开发环境

需要 Git、Node.js 和 npm；版本以 [package.json](../package.json) 的 engines 为准。在仓库根运行 `npm ci`，然后 `npm run build`。构建重建 dist；默认开发检查不需要登录产品或模型密钥。使用入口见[使用指南](./usage.md)。

Windows 11 是唯一经过真实使用验证的平台。CI 的平台矩阵由 [check.yml](../.github/workflows/check.yml) 定义，模拟测试通过不等于真实 Runtime、文件权限或终端输入体验已验证；剩余验证见[路线图](./roadmap.md)。

## 验证命令

| 改动或目的 | 命令 |
|---|---|
| 仅 Markdown 文档 | `npm run verify:docs` |
| 代码迭代中的快速反馈 | `npm run check:fast` |
| 代码改动收尾 | `npm run check` |
| 单项回归 | `npm run build` 后 `node --test dist/test/<对应文件>.test.js` |
| 全部测试 | `npm test`；仅构建已同步时使用 `npm run test:only` |
| 覆盖率 | `npm run test:coverage`，不在普通 check 中重复执行 |
| 发布前检查 | `npm run check:full`；与 check 的具体关系以编排脚本为准 |
| 修改 schema 或生成模板 | `npm run build`、`npm run gen:docs`、`npm run verify:generated` |
| TUI 渲染 | `npm run audit:tui:check`，代码收尾仍跑 check |

测试读取 dist，源码或测试变化后必须先构建；不能直接用 `node --test` 跑 TypeScript。lint 与类型检查分别检查不同问题，不能互相替代。按风险选择检查，不为一项文档修改重复执行全套测试。

## 工程门禁

[run-gates.mjs](../scripts/run-gates.mjs) 定义本地检查，[CI workflow](../.github/workflows/check.yml) 定义 CI lanes。字段、阈值和检查列表以脚本与配置为准，不维护第二套手写清单。

静态检查覆盖类型、lint、文档链接与预算、生成区、供应链、秘密、层级导入及受控源码。测试、未使用导出与重复代码检查负责行为和维护边界。npm 由 [npm-cli.mjs](../scripts/npm-cli.mjs) 解析后通过 Node 启动，避免 Windows shim 启动差异。

Windows TUI 帧与 [frames](./tui-audit/frames/) 逐字节比对并检查布局；非 Windows 的 audit 只生成与自检，不可覆盖 Windows 基线来消除差异。schema 字段表由 [生成器](../scripts/gen-docs.mjs) 产生，不手改生成区。

### 门禁必须能失败

新增或修改门禁必须同批包含能使其失败的自动化用例。覆盖率阈值只能升不能降，重复代码阈值不能放宽；不得以例外或非阻断失败隐藏问题。原因见[反向用例决策](./decisions/accepted/2026-08-15-gate-reverse-tests.md)。

失败证据应包含命令、退出码或启动错误、Node/OS 与提交信息。编排器的 `--self-test` 会故意构造失败；它证明诊断有效，不是产品失败。记录未运行的检查及原因，不能把 Agent 总结当作验证。

## 真实调用与费用

默认开发检查和 CI 不运行真实模型或 Runtime。真实调用必须明确授权，并设置对应脚本要求的环境变量；不要把开关加入日常验证默认值。普通 fixture、协议 probe 和完整任务验收是不同证据。

Codex 协议 smoke 的 PowerShell 示例：

```powershell
$env:REPRISE_RUN_CODEX_SMOKE = '1'
npm run smoke:codex
Remove-Item Env:REPRISE_RUN_CODEX_SMOKE
```

此命令会构建并执行 [codex-real-smoke.ts](../scripts/codex-real-smoke.ts)，验证无工具请求返回约定文字。它可能计费，既不执行完整实验，也不证明 Recovery、Controller 或报告效果。其他真实 runner 的入口、必填输入与 opt-in 以 [scripts](../scripts/) 中对应文件为准；不要复用过期样本路径或运行记录冒充新证据。真实验收缺口集中在[路线图](./roadmap.md)。

## 发布与回滚

发布包名为 `@caulif/reprise`，CLI 名为 `reprise`；裸名 npm 包不是本项目。发布前确认版本、tag、CHANGELOG 与持久化兼容策略一致，在干净检出执行安装与 check，并核对打包、依赖审计、秘密扫描结果。check 已覆盖的检查仅在证据失效时重跑。

先审查 `npm publish --access public --dry-run` 的文件清单；正式发布与推送 tag 属于外部写入，须由有权限的维护者执行。打包不得包含用户会话、凭据或本机实验。

故障版本可由维护者弃用，并验证回退版本能读取现有数据；没有兼容退路时保留原始数据并说明限制，不能原地改写未知版本 journal。事故记录至少说明影响、根因、修复、回归证据和剩余风险，可沿用 Issue，无需另建模板文件。
