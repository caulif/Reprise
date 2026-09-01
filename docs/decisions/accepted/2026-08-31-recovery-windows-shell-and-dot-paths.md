# 决策：Windows PowerShell 回退、`.` 为 staging 根

状态：accepted

## 问题

八工具落地后，真实恢复仍因 `powershell` 写死 pwsh 7 路径而全部 `spawn error`，且 `ls`/`grep` 把 `.` 当非法路径。Fingerprint 空变更被 Verifier 拒绝是正确的；操作者却只看到 `provider_validation_failed`。

## 决定

- Windows `powershell` 的发现、argv、UTF-8、超长 cwd 兜底与隔离目录名见[对齐 Pi 的启动语义](./2026-09-01-recovery-powershell-pi-spawn-and-short-paths.md)。`ProcessBoundaryError.errnoCode` 进入返回给模型的短句。不 `shell: true`，不灌全部 `process.env`。
- 工作区动词把省略路径、`""`、`.`、`./` 规范为 staging 根；`..`、空段、绝对路径、反斜杠继续拒绝。
- 核对页后续 user 用与冻结相同的注入块启发式过滤；不改 `initialInput`。
- 项目列表光标优先 `displayCwd` 落在项目 `path` 下，否则 `lastProjectKey`，再否则最近活动第一项。
- 变更为 0 的确认页诊断优先「没有观察到隔离工作区变更」；有变更但校验失败仍说工作区校验未通过。空变更不得 accept。

## 备选方案

**为绿灯跳过 fingerprint 空变更。** 放弃 Provider 边界。

**`shell: true` 或灌入完整环境以换 spawn 成功。** 扩大凭据与路径泄漏面。

## 影响

[Environment §7.1](../../architecture/environment.md#71-内部工作空间与实际边界)、Playbook / Recovery prompt、确认页与核对页文案。

## 验证

`test/recovery-tools.test.ts`：缺失 executable 含 `ENOENT`；staging 路径长于 MAX_PATH 时 `Remove-Item` 仍改 fingerprint；`ls(".")` 与省略 path 一致；`..` 仍失败。`test/recovery-ui.test.ts`：无变更与有变更校验失败文案分开。反向：把 `.` 再当非法、缺失 pwsh 只报空 `spawn error`、或长路径再把 CreateProcess cwd 设成 staging，测试红。
