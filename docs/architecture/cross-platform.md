# 本机平台边界

本文描述当前平台基础设施。已确认的 PowerShell/Bash 目标及三平台验收由[重构规划](../plan/reprise-architecture-redesign.md)拥有，不在这里定义另一套 Host 端口或迁移路线。

## 代码入口与实际边界

- [platform.ts](../../src/infrastructure/platform.ts)拥有 HostContext、shell 选择、本机路径打开与进程终止 helper。
- [process-runner.ts](../../src/infrastructure/process-runner.ts)拥有进程启动、取消、超时、输出限额和错误分类。
- [产品进程 helper](../../src/products/shared/process.ts)处理 Runtime 启动与 Windows shim；产品协议仍归各 Pack。
- [Pi Host](../../src/infrastructure/pi-agent-host.ts)记录模型可见 host facts；工具权限归对应角色。

当前 Windows 使用 PowerShell；POSIX 优先 SHELL，未设置时 macOS 使用 /bin/zsh、Linux 使用 /bin/bash。这是当前代码行为，不能写成目标“macOS/Linux 默认 Bash”已经生效。当前非 Windows 终止 helper 调用 child.kill，不据此承诺整个进程组已经被清理。

## 不变量

操作路径使用宿主路径语义并经过受控目录检查；持久化的历史路径身份与本机打开路径分开，见[路径比较决策](../decisions/accepted/2026-08-14-host-independent-recorded-paths.md)。大小写、链接、文件锁与权限不能由 OS 名称推断成功。模型可见平台信息必须在事件中可复原。

结构化 Runtime 协议优先，不解析原生 ANSI 画面决定投递或 turn settlement。平台基础设施不理解具体产品业务，不因为 shell 可执行就授予工具额外权限。取消请求、进程结束与残留资源事实分开。

## 验证范围

CI test matrix 的唯一来源是 [check.yml](../../.github/workflows/check.yml)，覆盖 Windows、macOS 与 Ubuntu。TUI 帧基线在 Windows 检查，不能证明其他终端的鼠标、选区、中文或退出恢复。支持声明见[支持边界](../SUPPORT.md)，真实调用准入见[smoke 闸门](../codex-smoke-gate.md)。
