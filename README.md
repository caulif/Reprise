# Reprise

Reprise 是本机优先的 Agent 任务重放与对照工具：选择历史会话，准备任务起点，在隔离副本中运行候选 coding agent，由模拟用户继续协作，再查看结果或按需生成对照报告。它不提供公共排名，也不把一次对照解释为纯模型能力的因果结论。

## 开始

需要 [package.json](./package.json) 声明的 Node 版本，以及所用 coding agent 的本机安装与登录。项目不代为安装产品，不读取或保存其 CLI 凭据。

```text
npm ci
npm run build
node dist/src/cli/main.js --help
node dist/src/cli/main.js
```

源码入口为 [CLI](./src/cli/main.ts)。当前 CLI 主要启动 TUI；通过 /config 配置内部模型，/intake 选择来源产品、项目与会话。恢复后选择候选产品与模型，确认执行；结果可以直接查看或按需对照。具体操作与凭据规则见 [TUI](./docs/product/tui.md)和[产品定义](./docs/product/overview.md#13-凭据)。内置产品由[注册入口](./src/products/index.ts)决定，当前包括 Codex 与 Claude Code。

默认数据目录为 .reprise，可通过 --data-dir 或 REPRISE_DATA_DIR 指定；来源目录可使用可重复的 --sessions-dir productId=path。模型调用可能产生费用，隔离副本不等于隐私清洗；实际运行前检查输入与权限。真实 smoke 必须显式 opt-in，见[准入程序](./docs/codex-smoke-gate.md)。

## 当前能力与重构目标

[文档入口](./docs/README.md)明确区分当前规范与已确认目标。完整无头 CLI、跨终端取消、外部本地插件及新的单列键盘 TUI 是[重构规划](./docs/plan/reprise-architecture-redesign.md)的一部分，不能将规划命令当作当前可执行接口。

平台支持与实际验证边界见[支持说明](./docs/SUPPORT.md)。CI 覆盖不等于所有平台的真实 Runtime 与终端行为已经验证。

## 贡献

```text
npm run check
```

只改文档运行 npm run verify:docs。其余验证、PR 和回滚要求见[贡献指南](./docs/CONTRIBUTING.md)。漏洞按[安全政策](./docs/SECURITY.md)私下报告。Coding agent 先读 [AGENTS.md](./AGENTS.md)，再按[文档导航](./docs/README.md)读取任务直接相关的规范；不要把历史 ADR 或本机草图当作新的实现指令。
