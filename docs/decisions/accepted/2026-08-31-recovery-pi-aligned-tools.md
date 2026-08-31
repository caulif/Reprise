# 决策：Recovery 工具面对齐 Pi 工作区动词

状态：accepted

## 问题

Recovery 注册约 15 个专用工具（inspect、delete、manifest sink、footprint 搜索等）。走查里删除上限误伤调查工具；Agent 填的 manifest 与信封 refs 对不齐导致整单作废。工作区动词并不比 Pi 的 `read`/`ls`/`grep`/`find`/`edit`/`write`/`powershell` 更能完成恢复。

## 决定

Recovery 只注册八个工具：`read`、`ls`、`grep`、`find`、`edit`、`write`、`powershell`、`read_observation`。Windows 只注册 `powershell`（cwd 锁 staging，净化 HOME，不给凭据），不注册 `bash`。报告约定 `write` 到 staging 根 `recovery.md`；校验后 Host 摘除。`recovery-manifest.json` 为 Host 保留名，Agent 不得写入。删除、改名与 Git 通过 `powershell` 或 `edit`/`write`。`allowShell` 不再作为默认隐藏 shell 的开关。本决策取代「staging_shell 默认不暴露」作为当前工具面。

Controller / Comparison 的 `read_observation`（`run_events`）不改名。

## 备选方案

**只把 Pi 八件套原样接进 Recovery。** 缺少冻结历史备胎，且默认 bash 不符合已验证的 Windows 平台。

**保留专用 manifest/delete 工具。** 继续把路径清单和删除预算绑在模型申报上。

## 影响

Playbook、时间线可见工具名、controlled-write journal 的 `write`/`edit` 字面量、以及 architecture §7.1 同步为本工具面。shell 仍是 unobserved writer。

## 验证

`test/recovery-tools.test.ts` 与 snapshots：注册名集合等于上表；反向：`delete_file` 等旧名未注册。
