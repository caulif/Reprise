# 决策：Recovery 用文件系统锁保护 source，readiness 只作诊断

状态：accepted
日期：2026-09-11

承接 [稀疏 source mount](./2026-09-11-recovery-sparse-source-mount.md) 与 [可观察判断](./2026-09-11-recovery-observable-judgment.md)。

## 问题

`shell_exec` 曾用命令文本判断是否写入 `source/`。PowerShell 变量、别名、`Set-Location`、间接路径和 junction 可以绕过该匹配，而 Recovery 必须能在工作副本里自由调查。Host 测量的 readiness 也曾在路径缺失或越界时把 `runnable` 改成 `blocked`，从而覆盖 Agent 已返回的 `ready`。

## 决定

Recovery 期间对用户真实 source 施加 NTFS 拒绝写入 ACE：Everyone 的 `WD,AD,DC`。不拒绝 `DELETE`：该权限会让 Node `readFile`/`scandir` 变成 `EPERM`，破坏 Host fingerprint。删除已有文件仍可能发生，由 source tripwire 检出。备份放在 Provider 根下 `sl/{recoveryId}`，不放在会被 `validateRecovery` 删除的 `rt/`。`accept` / `discard` / 失败回退在删除 staging 之前恢复 ACL。结构化 `write`/`edit` 仍拒绝只读 mount。`shell_exec` 对 Comparison 等角色的只读 mount 仍做命令文本拦截；它对 Recovery source 不是安全边界。Recovery 期间用 NTFS ACL 拒绝写入 source，Host 再核对 fingerprint。凭据文件名文本拦截仍在。Host 在封存前核对 source fingerprint；指纹变化仍是 tripwire 失败。junction 指向树外目标时，ACL 只约束 source 树内对象，不锁用户树外目录；结构化工具跳过逃逸链接。

`measureRecoveryStagingReadiness` 继续写入 `recovery.readiness_checked` 与报告诊断。`applyTaskReadinessGate` 不改写 `runnable`。`taskReadinessBlocksPublication` 恒为假。自动 accept 与 Candidate 启动只看 Agent 信封、路径边界、tripwire、报告存在性和预算等机械检查，不看 Host 推导任务路径是否存在或 readiness `blocked`。

本决定取代 [可观察判断](./2026-09-11-recovery-observable-judgment.md) 中「路径越界仍阻止发布」以及「`taskReadinessBlocksPublication` 只对越界为真」的条款。source tripwire、报告缺失和封存失败仍关闭本次恢复。

## 备选方案

**继续用命令文本拦截写 source。** 实现便宜，但不是可靠安全边界。

**把 source 复制进隔离只读卷或容器。** 隔离更强，但超出当前 Windows 已验证运行面，且大仓库复制预算问题仍然存在。

**readiness `blocked` 继续否决 ready。** 把 Host 推导路径重新做成任务能否开始的判断。

## 影响

Provider 在 `beginRecovery` 成功返回前加锁。Playbook 与 system prompt 说明文件系统拒绝写回 source，并允许从 `$env:REPRISE_SOURCE_MOUNT` 读到工作副本。旧状态类型与 `selection.ts` 不在本决定范围内。

## 验证

`test/environment/source-write-lock.test.ts`：加锁后 `writeFile` 失败，释放后可写。`test/application/recovery-tools.test.ts`：结构化工具 `write_denied`；经环境变量、间接路径和重定向的 shell 写入不能改变 source，且 `Copy-Item` 从 source 读到工作区仍可用。`test/application/codex-experiment-recovery-envelope.test.ts`：信封 `ready` 在 Host 路径越界诊断下仍自动 accept。`test/application/recovery-readiness.test.ts`：gate 不改 `runnable`，`blocked` 不阻止发布。反向：命令文本匹配作为唯一 source 写保护，或 readiness `blocked` 改写 `runnable` 并拒绝 accept，测试红。
