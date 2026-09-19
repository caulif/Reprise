# Reprise

[![check](https://github.com/caulif/Reprise/actions/workflows/check.yml/badge.svg)](https://github.com/caulif/Reprise/actions/workflows/check.yml)

**English:** Reprise is a local-first harness for replaying agent tasks on real history and comparing candidate runs. Documentation is primarily in Chinese; start at [docs/README.md](./docs/README.md).

Reprise 是本机优先的 Agent 任务重放与对照工具：选择历史会话，恢复任务起点，在隔离副本中运行候选 coding agent，由模拟用户继续协作，再查看结果或按需生成对照报告。它面向个人真实任务，不提供公共排名，也不把一次对照解释为纯模型能力的因果结论。

## 从源码开始

**以源码构建为准。** 包名是 scoped `@caulif/reprise`（因 npmjs 上已有无关的裸名包 `reprise`）。**当前尚未发布到 npm**；请从源码安装与运行，**不要**执行 `npm i reprise` / `npm install reprise`（会装到别人的包）。发布后安装示例为 `npm i @caulif/reprise`，CLI 命令名仍为 `reprise`。

需要 Node.js **22.19** 或更高版本，以 [package.json](./package.json) 的 `engines` 为准。在仓库根目录执行：

```powershell
git clone https://github.com/caulif/Reprise.git
cd Reprise
npm ci
npm run build
node dist/src/cli/main.js --help
```

以上步骤只需 Git、Node 和 npm，**不需要**模型密钥或产品登录。构建和查看帮助不调用模型。

准备体验交互界面时，在真实终端运行：

```powershell
node dist/src/cli/main.js
```

无子命令打开 TUI。源码检出**无需**全局安装 CLI；下文中的 `reprise` 均指上述 Node 入口或其构建产物，不是裸名 npm 包。若将来通过 `npm i -g @caulif/reprise` 安装，命令名相同。

### 三种前置条件

| 你想做什么 | 需要什么 |
|---|---|
| 查看帮助、跑离线检查 | 仅完成上方构建；见 [开发与验证](./docs/development.md) |
| 从历史会话恢复并运行候选 | 已安装来源产品（Codex、Claude Code 等）且本机有真实历史；通过 TUI `/intake` 选择 |
| 调用 Harness 内部模型 | 在 TUI `/config` 配置 Recovery、Controller、Comparison 共用的模型；可能产生服务费用 |

执行真实任务前，候选 Runtime 使用目标产品中的登录态；Harness 内部模型在 `/config` 单独配置。恢复环境、执行候选和生成对照都可能调用模型并产生费用；操作与确认边界见 [使用指南](./docs/usage.md)。

默认数据目录是当前目录下的 `.reprise`，可用 `--data-dir` 或 `REPRISE_DATA_DIR` 指定其他路径。无头命令以 `--help` 和 [CLI 源码](./src/cli/main.ts) 为准。

## 你会得到什么

一次完整流程大致产生：

1. **封存任务** — 从历史会话冻结的 `TaskCase` 与恢复后的隔离工作区。
2. **候选运行** — 事件日志、trace、候选终稿与保留在 `environment/runs/{runId}` 的隔离副本。
3. **可选对照** — 本机 `report.html` 及配套媒体，比较历史终稿与候选交付。

```text
历史会话 → 恢复结论（已恢复 / 部分恢复） → 候选运行 → 结果页（报告 / 终稿 / trace）
```

TUI 是事件日志的只读投影；它显示压缩后的工具活动与可见决策，不伪造未公开的推理过程。详细路径见 [使用指南](./docs/usage.md#tui-路径)。

## 当前试用限制

以下问题在源码中可见，尚未完全修复；详情与修复条件见 [路线图](./docs/roadmap.md#已知实现问题)：

- **同一 Experiment 的重复完整运行**可能因固定的 `controller-started` 与实验级 operation 去重冲突而失败。
- **对照报告重生成**先替换正式 HTML、再复制媒体；媒体步骤失败时，旧的成功报告可能不可用或与新旧内容混用。重要报告重生成前请自行备份 `report.html` 及媒体目录。

公开源码不自动承诺稳定发行；是否修完后再发布由维护者决定。

## 使用边界

Windows 11 是唯一经过真实使用验证的平台。上方 CI badge 只表示 [check](./.github/workflows/check.yml) 工作流状态：**CI 绿灯 ≠ 真终端 / 真 Runtime 已在三平台验证**（见 [路线图](./docs/roadmap.md#平台与真实-runtime-证据)）。

实验记录和工作副本保存在本机（默认 `.reprise`，或你指定的 `dataDir`）。Recovery、Controller、Comparison 会将完成任务所需的历史内容、工作区观察和工具结果发送到配置的模型服务；候选 Runtime 的数据处理由目标产品决定。秘密过滤不保证清除全部个人信息或业务内容。详见 [使用指南：数据去向](./docs/usage.md#数据去向)。

默认开发验证与 CI 不运行真实 Runtime smoke，不产生模型调用费用；真实 smoke 必须通过环境变量显式 opt-in，遵守 [开发与验证：真实调用与费用](./docs/development.md#真实调用与费用)。隔离副本不是隐私清洗或外部副作用回滚：实际运行前检查输入、权限与预算。凭据处理见 [使用指南：配置与边界](./docs/usage.md#配置-harness-内部模型)；漏洞请按 [安全政策](./docs/SECURITY.md) 私下报告。

## 了解、支持与贡献

了解、支持与贡献：从 [文档导航](./docs/README.md) 进入 [使用指南](./docs/usage.md)、[架构总览](./docs/architecture/overview.md) 与 [日常开发](./docs/development.md)。`docs/tui-audit/frames/` 等列在导航的「不要读什么」里：它们是 **CI 门禁基线**，不是阅读材料。coding agent 先读 [AGENTS.md](./AGENTS.md)，再读任务直接相关的规范。

项目使用 [MIT 许可证](./LICENSE)。参与讨论与贡献请遵守 [行为准则](./docs/CODE_OF_CONDUCT.md)；维护与决策方式见 [贡献指南](./docs/CONTRIBUTING.md)。
