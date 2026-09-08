# 决策：跨平台 Host 与 Agent 工具边界

状态：accepted

## 问题

固定 PowerShell 工具名将平台语法泄漏到 Agent prompt，阻碍 POSIX 宿主复用同一工具面。

## 决定

Reprise 的 Core、Agent session 和事件协议不直接选择操作系统。启动层生成 HostContext，infrastructure 根据 HostContext 选择路径、shell、进程取消和可选终端能力。Agent 使用语义工具 `shell_exec`（文档语义名为 `shell.exec`，注册名遵守 Pi 工具安全命名限制），不再依赖固定的 `powershell` 工具名。

shell 工具默认由 Host 以 `file + args[]` 启动：Windows 使用 PowerShell，macOS 与 Linux 使用 `/bin/bash`。不读取 `SHELL`。只有 Host 生成 shell adapter 命令时才进入 shell；Agent 输入仍受 cwd、环境、超时、输出上限和敏感文件规则约束。进程树、WSL 本机路径与收尾时限见[原生平台语义](./2026-09-08-native-platform-semantics.md)。

### 原因

Pi Agent Core 的工具 schema、before/after tool hooks、AbortSignal 和事件 barrier 已经提供了跨平台 Agent 执行所需的边界。Codex app-server 和 Claude Code 的结构化模式也表明，Runtime 应优先走协议而不是解析交互式终端。固定 PowerShell 名称会把 Windows 语法泄漏到 Agent prompt，并阻碍 POSIX 宿主复用同一工具面。

## 备选方案

**在应用层选择操作系统**：让业务流程承担基础设施职责，因此由 Host adapter 负责。

## 影响

- 审计事件记录语义工具名、shell kind 和 host facts；历史事件仍可由 UI 兼容显示。
- Windows 的 PowerShell 长 cwd、环境净化和进程树清理继续由 Windows adapter 负责。
- macOS/Linux 需要在真实 CI 中验证 shell executable、process group、权限和无 TTY 退化。
- 新增平台能力必须先增加 Host 端口和契约测试，不在应用层添加平台分支。

## 验证

平台、进程 runner 与 Agent 工具测试覆盖 shell 选择、参数传递、取消和输出边界；CI test lane 覆盖 Windows、macOS 和 Ubuntu。
