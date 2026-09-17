# Reprise

Reprise 是本机优先的 Agent 任务重放与对照工具：选择历史会话，恢复任务起点，在隔离副本中运行候选 coding agent，由模拟用户继续协作，再查看结果或按需生成对照报告。它面向个人真实任务，不提供公共排名，也不把一次对照解释为纯模型能力的因果结论。

## 从源码开始

用 Git 检出仓库后，在仓库根目录执行以下命令。需要 Node.js `>=22.19.0` 和 npm，版本要求以 [package.json](./package.json) 为准；此步骤不需要模型密钥或产品登录。

包名是 scoped `@caulif/reprise`（因 npmjs 上已有无关的 `reprise` 包）。**当前尚未发布到 npm**；请从源码安装与运行，不要执行 `npm install reprise`（会装到别人的包）。发布后安装示例为 `npm i @caulif/reprise`，CLI 命令名仍为 `reprise`。

```text
npm ci
npm run build
node dist/src/cli/main.js --help
```

构建和查看帮助不调用模型。准备体验交互界面时，在真实终端运行：

```text
node dist/src/cli/main.js
```

无子命令打开 TUI；源码检出无需全局安装 CLI；需要时用源码构建产物或（发布后）`npm i -g @caulif/reprise`。执行真实任务前，需自行安装并登录所选产品（内置 Codex、Claude Code），通过 `/config` 配置 Harness 内部模型，再通过 `/intake` 选择来源产品、项目与历史会话。恢复环境、执行候选和生成对照都可能调用模型并产生费用；操作与确认边界见 [TUI 使用说明](./docs/product/tui.md)。

默认数据目录是 `.reprise`，可用 `--data-dir` 或 `REPRISE_DATA_DIR` 指定。无头命令以 `--help` 和 [CLI 源码](./src/cli/main.ts) 为准；产品主路径与非目标见[产品定义](./docs/product/overview.md)。

## 使用边界

Windows 11 是唯一经过真实使用验证的平台；跨平台 CI 模拟测试不等于 macOS/Linux 真实终端或 Runtime 已获验证，详见[支持说明](./docs/SUPPORT.md)。

默认开发验证与 CI 不运行真实 Runtime smoke，不产生模型调用费用；真实 smoke 必须通过环境变量显式 opt-in，遵守[准入程序](./docs/codex-smoke-gate.md)。隔离副本不是隐私清洗或外部副作用回滚：实际运行前检查输入、权限与预算。凭据处理见[产品安全边界](./docs/product/overview.md#13-凭据)，漏洞请按[安全政策](./docs/SECURITY.md)私下报告。

## 了解与贡献

从[文档导航](./docs/README.md)进入[产品定义](./docs/product/overview.md)、[架构总览](./docs/architecture/overview.md)与[贡献指南](./docs/CONTRIBUTING.md)。本地命令见[日常开发](./docs/development.md)；coding agent 先读 [AGENTS.md](./AGENTS.md)，再读任务直接相关的规范。

项目使用 [MIT 许可证](./LICENSE)。参与讨论与贡献请遵守[行为准则](./docs/CODE_OF_CONDUCT.md)；维护与决策方式见[治理说明](./docs/GOVERNANCE.md)。
