# 技术选型与实现基线

本文解释当前依赖与基础设施选择。领域规范见[架构总览](./overview.md)，目标变化见[重构规划](../plan/reprise-architecture-redesign.md)。

## 运行时与依赖

单一 TypeScript/ESM npm 包，保持模块化单体。版本与脚本以 [package.json](../../package.json)、[lockfile](../../package-lock.json)为准，不复制第二份依赖 JSON。Node 最低版本为 engines 声明的基线。

Pi Agent Core、pi-ai、pi-tui 分别用于执行循环、模型适配与终端组件。共用 [Pi Host](../../src/infrastructure/pi-agent-host.ts)，业务权限、生命周期和持久化不交给另一套通用应用壳。Pi 高级 API 是否可用以安装版本的行为检查为准，不能由声明推断已实现。

## CLI 与 TUI

[CLI 入口](../../src/cli/main.ts)使用 node:util.parseArgs，目前启动 TUI 并提供帮助、版本和启动选项。完整非交互 run/prepare/compare/cancel 是目标能力，不能作为当前命令写入使用说明。当前界面见 [TUI](../product/tui.md)，目标键盘交互见 [TUI 规划](../plan/reprise-tui-design.md)。

渲染从记录与公共活动投影，不从终端屏幕推断产品输入是否接受；不建设通用 PTY 或第二个控制面。只在具体产品确有需求时评估产品内适配，不提前添加 native helper 依赖。

## Schema、进程与存储

TypeBox 验证磁盘、外部协议与模型输出；同进程已类型化调用不重复加运行时校验。当前字段由 [schema.ts](../../src/core/schema.ts)及其引用定义拥有。JSON/JSONL、附件和写者锁见[持久化规范](./persistence-and-crash-consistency.md)。

使用 Node 进程与文件能力，具体跨平台行为见[本机平台边界](./cross-platform.md)。Windows shim 通过[产品进程 helper](../../src/products/shared/process.ts)启动，不能假设 .cmd 等同于原生 executable。目标支持不等于已完成真实终端与 Runtime 验证。

## Product Pack 加载

当前 [注册入口](../../src/products/index.ts)静态注册 Codex 与 Claude Code。契约见[兼容性规范](./product-plugin-compatibility.md)。外部可信本地插件已被确认进入目标设计，但尚不能作为当前可安装能力承诺；目标加载规则只在[重构规划](../plan/reprise-architecture-redesign.md#插件与场景的稳定边界)维护。

## 报告与发布

对照报告归 Comparison attempt，HTML 与证据链接按[对照规范](./comparison.md)发布。报告失败不覆盖候选结果或旧成功报告。不建立服务端 Web 应用。

保留一个 npm 发布入口，依赖变更必须有实际需求，避免重复实现已有 Pi 或标准库能力。发布前按[发布检查](../release-checklist.md)验证，不在本文件维护另一份门禁或平台清单。
