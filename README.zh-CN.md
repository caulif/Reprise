# Reprise

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![check](https://github.com/caulif/Reprise/actions/workflows/check.yml/badge.svg)](https://github.com/caulif/Reprise/actions/workflows/check.yml)

> **实验性项目。** Reprise 是一个本机优先的工具：它从真实的 coding agent 任务中恢复起点，让候选 Agent 从相同起点重新执行，并帮助你查看两次结果的差异。

当一次 Agent 协作任务值得重新检验时，Reprise 可以保留任务上下文、恢复隔离工作区、运行另一个候选 Runtime，并用可追溯的证据查看结果。它面向个人、本机实验，不是公共排行榜，也不是能够证明模型能力的标准 benchmark。

## 演示

<!-- 在这里加入 TUI 流程或对照报告的截图。 -->

_这里后续会加入一段简短的 TUI 流程和一张对照报告截图。流程是：选择已保存会话，恢复任务起点，运行候选 Agent，然后在本机查看结果。_

## 你会得到什么

- **封存的任务案例**：从本机 Agent 历史会话中提取任务，并记录恢复结论和已知缺口。
- **隔离的候选运行**：保留事件日志、trace、候选终稿及运行后的工作副本。
- **可选的对照报告**：将历史和候选证据并列呈现，而不是压缩成单一分数。

```text
历史 Agent 会话 -> 恢复后的任务案例 -> 候选运行 -> 本机证据与对照报告
```

## 快速开始

当前请从源码运行 Reprise。需要 Git、npm 和 Node.js **22.19 或更高版本**。

```powershell
git clone https://github.com/caulif/Reprise.git
cd Reprise
npm ci
npm run build
node dist/src/cli/main.js --help
```

以上命令只会构建 Reprise 并显示帮助，不需要模型密钥或产品登录，也不会调用模型。

打开终端界面：

```powershell
node dist/src/cli/main.js
```

从 `/intake` 开始，依次选择来源产品、项目和已保存会话。恢复完成后，选择候选产品与模型，核对确认页，再启动候选运行。完整 TUI 路径和无头 CLI 用法见[使用指南](./docs/usage.md)。

## 前置条件与支持范围

| 你想做什么 | 需要什么 |
|---|---|
| 构建、查看帮助或运行离线检查 | 仅需满足快速开始的前置条件 |
| 恢复会话并运行候选 | 本机已安装受支持的产品，且保留了本机会话历史 |
| 调用 Recovery、Controller 或 Comparison 模型 | 在 `/config` 配置 Harness 模型；这些操作可能产生服务费用 |

目前只有 Windows 11 经过真实终端和 Runtime 使用验证。CI 通过不等于所有操作系统上都已完成同等的真实 Runtime 验证；验证范围和剩余工作见[路线图](./docs/roadmap.md)。

默认数据目录是当前目录中的 `.reprise`。可使用 `--data-dir` 或 `REPRISE_DATA_DIR` 指定其他位置。

## 隐私、费用与安全

- 实验记录和工作副本保存在本机；但 Recovery、Controller 与 Comparison 会将完成任务所需的材料发送给你配置的 Harness 模型服务。
- 候选 Runtime 使用各自产品的登录态和数据处理规则。Reprise 不提供通用网络沙箱，也不会回滚外部副作用。
- 在真实运行前检查任务输入、权限、隐私和预算。秘密过滤不保证能够移除全部个人信息或业务内容。

使用真实工作内容前，请阅读[数据去向与凭据边界](./docs/usage.md#数据去向)，对于有外部副作用的任务应使用测试账号、mock 或只读观察。

## 项目状态

Reprise 仍处于实验阶段，尚未发布到 npm。未来包名会是 `@caulif/reprise`；请不要安装 npm 上无关的裸名 `reprise` 包。

当前实现限制和仍待验证的真实 Runtime 行为见[路线图](./docs/roadmap.md)。

## 文档

| 目标 | 阅读入口 |
|---|---|
| 通过 TUI 或 CLI 运行 Reprise | [使用指南](./docs/usage.md) |
| 理解模块和执行流程 | [架构总览](./docs/architecture/overview.md) |
| 配置开发环境并运行检查 | [开发与验证](./docs/development.md) |
| 查看限制与验证证据 | [路线图](./docs/roadmap.md) |
| 浏览完整文档导航 | [文档首页](./docs/README.md) |

## 支持与贡献

提问和想法请使用 [GitHub Discussions](https://github.com/caulif/Reprise/discussions)，可复现的缺陷请提交到 [GitHub Issues](https://github.com/caulif/Reprise/issues)。准备贡献前，请阅读[贡献指南](./docs/CONTRIBUTING.md)、[行为准则](./docs/CODE_OF_CONDUCT.md)和[开发与验证](./docs/development.md)。

请不要在公开内容中贴出凭据、真实会话正文或未经脱敏的实验产物。

## 安全与许可证

漏洞请按[安全政策](./docs/SECURITY.md)私下报告。Reprise 使用 [MIT 许可证](./LICENSE)。
