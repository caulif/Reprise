# 技术选型与实现基线

本文解释当前依赖与基础设施选择。领域规范见[架构总览](./overview.md)，目标变化见[重构规划](../plan/reprise-architecture-redesign.md)。

## 运行时与依赖

单一 TypeScript/ESM npm 包，保持模块化单体。版本与脚本以 [package.json](../../package.json)、[lockfile](../../package-lock.json)为准，不复制第二份依赖 JSON。Node 最低版本为 engines 声明的基线。

Pi Agent Core、pi-ai、pi-tui 分别用于执行循环、模型适配与终端组件。三个内部角色共用 [AgentHost](../../src/infrastructure/agent/host.ts)；Pi 仅出现在 `providers/pi/` 适配器。业务权限、生命周期和持久化不交给另一套通用应用壳。锁定 0.84.1 时，公开 `Agent` loop 可用；`AgentHarness.prompt`/`compact`/`resume` 抛出 `HarnessNotImplemented`。Session 事实写入 Experiment `events.jsonl`，不以 Pi JSONL 为权威，见[事实源决策](../decisions/accepted/2026-09-08-session-fact-owner-and-identity.md)与[基座 Host](../decisions/accepted/2026-09-09-agent-foundation-host.md)。模型可见试卷从同一日志与 `agent_model_input` 附件重建，见[模型输入重建](../decisions/accepted/2026-09-08-model-input-reconstruction.md)。

## CLI 与 TUI

[CLI 入口](../../src/cli/main.ts)使用 `node:util.parseArgs`。无子命令打开 TUI。查询、配置、prepare、run、compare、cancel 不加载 TUI。机器输出是互斥的 `--json` 单结果或 `--jsonl` 事件流；诊断在 stderr。退出码与字段见[CLI 协议决策](../decisions/accepted/2026-09-08-cli-query-config-protocol.md)。当前界面见 [TUI](../product/tui.md)。选择与配置按键见[TUI 选择与配置按键](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)。目标交互见 [TUI 规划](../plan/reprise-tui-design.md)。

渲染从记录与公共活动投影，不从终端屏幕推断产品输入是否接受；不建设通用 PTY 或第二个控制面。只在具体产品确有需求时评估产品内适配，不提前添加 native helper 依赖。

## Schema、进程与存储

TypeBox 验证磁盘、外部协议与模型输出；同进程已类型化调用不重复加运行时校验。当前字段由 [schema.ts](../../src/core/schema.ts)及其引用定义拥有。JSON/JSONL、附件和写者锁见[持久化规范](./persistence-and-crash-consistency.md)。

使用 Node 进程与文件能力，具体跨平台行为见[本机平台边界](./cross-platform.md)。Windows shim 通过[Runtime spawn](../../src/infrastructure/process/spawn.ts)启动，不能假设 .cmd 等同于原生 executable。目标支持不等于已完成真实终端与 Runtime 验证。

## Product Pack 加载

内置 Codex 与 Claude Code 与 `{dataDir}/plugins.json` 列出的本地模块走同一 [registry](../../src/products/index.ts)。契约见[兼容性规范](./product-plugin-compatibility.md)。加载规则见[版本化本地 Pack 边界](../decisions/accepted/2026-09-08-versioned-local-pack-boundary.md)。不执行原始 TypeScript，不远程发现，不热加载。

## 报告与发布

对照报告归 Comparison attempt，HTML 与证据链接按[对照规范](./comparison.md)发布。报告失败不覆盖候选结果或旧成功报告。不建立服务端 Web 应用。

保留一个 npm 发布入口，依赖变更必须有实际需求，避免重复实现已有 Pi 或标准库能力。发布前按[发布检查](../release-checklist.md)验证，不在本文件维护另一份门禁或平台清单。
