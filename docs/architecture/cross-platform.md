# 本机平台边界

本文描述当前平台基础设施。已确认的 PowerShell/Bash 目标及三平台验收由[重构规划](../plan/reprise-architecture-redesign.md)拥有，不在这里定义另一套 Host 端口或迁移路线。

## 代码入口与实际边界

- [platform.ts](../../src/infrastructure/platform.ts)拥有 HostContext、shell 选择、本机路径打开与进程终止 helper。
- [process-runner.ts](../../src/infrastructure/process-runner.ts)拥有进程启动、取消、超时、输出限额和错误分类。
- [产品进程 helper](../../src/products/shared/process.ts)处理 Runtime 启动与 Windows shim；产品协议仍归各 Pack。
- [Pi Host](../../src/infrastructure/pi-agent-host.ts)记录模型可见 host facts；工具权限归对应角色。
- [control-endpoint.ts](../../src/infrastructure/control-endpoint.ts)拥有跨终端 cancel 的本机管道/Unix socket；认证 token 不进事件。规则见[跨终端 cancel](../decisions/accepted/2026-09-08-cross-terminal-cancel.md)。

当前 Windows 使用 System32 `powershell.exe`；macOS 与 Linux 使用 `/bin/bash`。不读取 `SHELL`。缺省 shell 不存在则失败，不回退。`runProcess` 与 Runtime spawn 均为 `shell: false`。POSIX 杀进程树时 detached 并对进程组发 SIGKILL；Windows 用 System32 `taskkill /T`。WSL 只使用发行版路径，发现可执行文件时跳过盘符路径与 `/mnt/<盘符>/`。CandidateRun 等待 `stop` 超过收尾时限则 cleanup 为 `unknown`。细节见[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。

## 不变量

操作路径使用宿主路径语义并经过受控目录检查；持久化的历史路径身份与本机打开路径分开，见[路径比较决策](../decisions/accepted/2026-08-14-host-independent-recorded-paths.md)。大小写、链接、文件锁与权限不能由 OS 名称推断成功。模型可见平台信息必须在事件中可复原。

结构化 Runtime 协议优先，不解析原生 ANSI 画面决定投递或 turn settlement。平台基础设施不理解具体产品业务，不因为 shell 可执行就授予工具额外权限。取消请求、进程结束与残留资源事实分开。

## 验证范围

证据分三类，不能互相顶替：

1. **平台模拟**：CI [check.yml](../../.github/workflows/check.yml) 在 Windows、macOS、Ubuntu 跑同一套离线测试；shell、路径、进程见[原生平台语义](../decisions/accepted/2026-09-08-native-platform-semantics.md)。
2. **真实终端**：TUI 帧基线与假终端按键在 Windows 检查。中文、IME、滚轮、拖选、链接、异常退出恢复尚未在 macOS/Linux 真终端关闭。
3. **真实 Runtime**：Codex/Claude smoke 仅显式环境变量准入，见[smoke 闸门](../codex-smoke-gate.md)；缺授权时保持缺口。

第三测试 Pack 经配置加载，见[第三 Pack 与平台证据](../decisions/accepted/2026-09-08-third-pack-and-platform-evidence.md)。支持声明见[支持边界](../SUPPORT.md)。
