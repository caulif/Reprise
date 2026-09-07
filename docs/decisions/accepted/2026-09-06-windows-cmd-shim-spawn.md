# 决策：Windows `.cmd` shim 的 Runtime 启动方式

状态：accepted

## 问题

npm 在 Windows 上把 `codex`/`claude` 装成 `.cmd` shim。Reprise 发现路径会命中该 shim，再经 `cmd.exe /d /s /c` 启动。若把已经加引号的整行当作 spawn 的一个 argv，Node 会再转义一次，cmd 实际看到 `\"C:\...\codex.cmd\"`，立刻以退出码 1 结束。TUI 拉 Codex 模型目录时只显示 `Codex app-server exited (1, none)`，候选回合从未开始。`shell: true` 能碰巧跑通，但触发 DEP0190，且与「argv 数组、`shell: false`」冲突。

## 决定

Product Pack 启动目标 Runtime 一律走 `spawnRuntimeProcess`。Windows 上 `.cmd`/`.bat` 使用 ComSpec `/d /s /c`，把 `"<已按 token 加引号的命令行>"` 作为 `/c` 的唯一其余参数，并设置 `windowsVerbatimArguments`。`/S` 剥掉最外层引号后留下 `"shim" arg…`。非 shim 可执行文件仍按 argv 数组 `shell: false` 启动。进程异常退出时，错误消息附带脱敏后的 stderr 摘要。

## 备选方案

**只修引号、继续让 Codex 私有拼 cmd 行。** Claude Code 的 npm `.cmd` 会重复同一失败；Process Host 与 Pack 的职责会继续分叉。

**`shell: true` 启动 `.cmd`。** 能避开二次转义，但 Node 会拼接未转义的命令行，且与技术选型禁止用 shell 解决 PATH 冲突。

**解析 npm shim，改为 `node.exe` + `codex.js`。** 绑死 npm 布局，对原生 `.exe` 和其它 `.cmd` 包装无效。

**发现阶段跳过 `.cmd`、只认 `.exe`。** 本机全局 npm 安装通常没有并列的 `.exe`，等于把默认安装路径标成未安装。

## 影响

- Pack 不得各自再写一套 ComSpec 拼接。
- 真实 Codex/Claude 目录探测与候选启动依赖这条路径；假 app-server 仍用 `node.exe` + 脚本，不受 shim 规则影响。
- 退出错误可能含 cmd 诊断句，必须经过现有 stderr 脱敏。

## 验证

- `windowsProcessInvocation` 对带空格的 `.cmd` 路径和 `app-server --listen stdio://` 生成 `/d /s /c` 加外层引号，并要求 verbatim。
- Windows 上：带空格目录的 `.cmd` 能带额外参数启动；同一 shim 在 Node 默认二次加引号下退出非 0。
- Windows 上：`CodexAppServerClient` 经 `.cmd` 包装的假 app-server 能完成 `initialize`。
