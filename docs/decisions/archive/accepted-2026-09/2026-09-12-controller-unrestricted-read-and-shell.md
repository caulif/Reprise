# 决策：Controller 读取不设工作区 containment，并注册 shell_exec

状态：accepted
日期：2026-09-12

## 问题

Controller 要像真实用户一样调查候选隔离副本和外部历史材料，但读取路径被限制在 briefing、changed paths 和最新 turn。工具面又不注册 `shell_exec`，briefing 还声称没有该工具。模型无法读取用户选择的其他可读材料，工具说明与实际能力也不一致。

## 决定

Controller 读取与写入分成两条解析路径。`ls`、`read`、`grep`、`find` 走 `resolveReadPath`：相对路径相对 briefing 根，`project/` 仍是隔离副本挂载，绝对路径、UNC 与当前进程可读路径允许访问，不做 write containment。单次字节数、深度、匹配数、凭据文件名、符号链接叶节点和超时仍生效。WSL 风格路径在宿主读不到时返回 `wsl_unavailable`，不把不可访问说成普通缺失。

`edit` / `write` 继续走 `resolveWritePath` / `pathIn`：只写 `project/` 下文件，拒绝绝对路径、`source/`、briefing、`..`、symlink 与 junction 越界。原始 source fingerprint 与 Candidate 快照检查不变。

`controllerDecisionTools()` 以 `allowShell: true` 注册 `shell_exec`。cwd 锁定候选隔离副本。命令可以读取任意宿主可读路径。候选副本外的 shell 写入记 `controller.external_write`，不得记成 `controller.workspace_write`。Candidate 结果与 Comparison 输入通过 `controllerExternalWritePaths` 暴露这些路径引用。是否把外部写入算进可发布结果，仍由 CandidateRun 既有策略决定。

成功 `read` 按路径分类记 `controller.observation_read`：`briefing_read`、`workspace_read` 或 `external_read`。shell 调查记 `shell_observation`。事件保存脱敏路径或分类、字节/截断、evidence ref 与结果 hash，不把完整外部内容复制进事件。

本决定取代 [协作工具面](./2026-09-10-controller-collaboration-workspace-tools.md) 中「不注册 `shell_exec`」和「steering 仅 changed paths / 最新 turn 可记 `workspace_read`」的条款。不注册 `read_observation`、发给候选的唯一用户输入仍是信封 `message`、不得改 CandidateRun 状态机、`edit`/`write` 不得写用户源目录，继续有效。

## 备选方案

**只放宽读取、shell 外部写入仍拒绝。** 调查命令一旦碰到重定向或安装脚本会失败；与「像真实用户调查」不一致。

**继续六件套且读取 containment。** 外部历史会话和 WSL 材料无法检查，briefing 与工具面继续撒谎。

## 影响

[Controller 设计](../../../architecture/controller.md)、[实验条件](../../../architecture/controller.md#4-实验条件)、[环境 §7.1](../../../architecture/environment.md#71-内部工作空间与实际边界)、[总览安全边界](../../../architecture/overview.md#14-安全边界)、[validation Capability](../../../architecture/overview.md#附录最小验证边界)。

## 验证

- `test/application/controller-tools.test.ts`：外部 `read`/`ls`/`grep`/`find` 成功；`shell_exec` 注册且 cwd 为副本；外部 shell 写入不是 `controller.workspace_write`；`edit`/`write` 拒绝 source、briefing、绝对路径和 junction。
- `test/core/architecture.test.ts`：Controller 工厂七件套；`controller-tools.ts` 含 `allowShell: true` 与 `unrestrictedRead: true`；prompt/briefing 不再声称没有 `shell_exec`。
- `test/core/store.test.ts`：畸形 `controller.external_write` 拒收。
- 反向：去掉 `allowShell`、或外部 `read` 再报 containment、或 shell 外部写入记成 `workspace_write`，测试红。
- `npm run check`。
