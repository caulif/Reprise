# Reprise

[![check](https://github.com/caulif/Reprise/actions/workflows/check.yml/badge.svg)](https://github.com/caulif/Reprise/actions/workflows/check.yml)

Reprise 是本机优先的 Agent 任务重放与对照工具：选择历史会话，恢复任务起点，在隔离副本中运行候选 coding agent，由模拟用户继续协作，再查看结果或按需生成对照报告。它面向个人真实任务，不提供公共排名，也不把一次对照解释为纯模型能力的因果结论。

## 从源码开始

需要 Git、Node.js 和 npm，版本要求见 [package.json](./package.json)。包名为 `@caulif/reprise`，CLI 名为 `reprise`。当前以源码构建为准；npm 上的裸名 `reprise` 是其他项目。

```text
npm ci
npm run build
node dist/src/cli/main.js --help
node dist/src/cli/main.js
```

构建与查看帮助不调用模型。最后一条命令在真实终端打开 TUI。先安装并登录所选目标产品（内置 Codex、Claude Code），用 `/config` 配置内部模型，再用 `/intake` 选择历史会话。恢复、候选运行、连接测试和对照都可能计费。

默认数据目录为 `.reprise`，可用 `--data-dir` 或 `REPRISE_DATA_DIR` 指定。操作、模型与凭据配置见[使用指南](./docs/usage.md)。

## 使用边界

Windows 11 是唯一经过真实使用验证的平台。CI 模拟测试通过不代表其他平台的真实 Runtime、终端和权限行为已验证；开放验证与已知问题见[路线图](./docs/roadmap.md)。

隔离副本不是隐私清洗或外部副作用回滚。实际运行前检查任务材料与权限。默认开发检查不调用计费模型，真实验证需要显式 opt-in，见[开发指南](./docs/development.md#真实调用与费用)。

## 支持与贡献

先查[使用指南](./docs/usage.md)与已有 Issues。报告问题请提供提交或版本、Node/OS/终端、最小复现、预期与实际结果、脱敏命令和退出码；优先使用本地 fixture。功能建议说明用户问题和替代方案。项目由单人维护，不承诺响应时限、代付模型费用或产品账号支持。

漏洞走[私下安全渠道](./docs/SECURITY.md)，不要公开凭据或私有会话。贡献与维护职责见[贡献指南](./docs/CONTRIBUTING.md)，深入实现见[文档导航](./docs/README.md)。Coding agent 先读 [AGENTS.md](./AGENTS.md)。项目使用 [MIT](./LICENSE)，参与者遵守[行为准则](./docs/CODE_OF_CONDUCT.md)。
