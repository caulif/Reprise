# 决策：大仓库按需恢复与只读 source mount

状态：accepted

单工作副本与三轮 Session 仍有效，见 [自主三轮循环](./2026-09-09-recovery-single-workspace-agent-loop.md)。

## 问题

Recovery 在启动 Agent 前完整复制当前源目录。大型仓库中的 `node_modules`、构建产物和缓存会先耗尽复制预算，Provider 以 `source_budget_blocked` 失败，Agent 没有机会判断任务实际需要什么。

## 决定

源目录、可写工作区和封存 baseline 是三条不同路径。源目录总文件数、总字节和单文件大小只决定能否整树复制，不决定 Recovery 能否启动。小型源目录可以复制为初始工作区；超预算时创建稀疏工作区，挂载只读 `source/`，写入目录摘要，然后启动同一个 Recovery Session。Agent 用现有七个工具按需读取和复制；`shell_exec` 在 Recovery 生产路径默认开启，cwd 锁定可写工作区。最终只对工作区做 fingerprint、预算和 baseline 封存。工作区过大或无关目录无法复制本身不是 `blocked`；影响任务的缺口才是。Host 不新增大仓库专用复制工具。

## 备选方案

**提高 5 万文件 / 1GB 上限**：推迟失败，仍把整树复制当成启动条件。

**按 gitignore 或产品类型排除后再复制**：Host 重新做内容策展，无法覆盖任务真正需要的生成物或依赖。

**新增 copy_file / inspect_source DSL**：扩大工具面，且不能替代 shell 与按路径读取。

## 影响

`beginRecovery` 不再把源目录预算失败当成 Agent 启动失败。工具路径区分 `workspace/` 与 `source/`。System Prompt、三个 turn prompt 和产品 Playbook 说明只读源目录与按需恢复。源目录 tripwire、链接逃逸、凭据拦截和工作区预算仍由 Host 执行。

## 验证

`test/application/recovery-sparse-source.test.ts` 覆盖超预算仍启动、深层文件按需复制、无关目录不复制、baseline 可复用和 source tripwire。`test/application/recovery-tools.test.ts` 覆盖 source 只读、observations 不可写、绝对路径拒绝和 junction 逃逸。`test/architecture.test.ts` 禁止把 `runnable !== isolated` 重新当作 beginRecovery 失败条件，并要求 Recovery 生产路径注册 `source` mount 与 `shell_exec`。相关门禁与 `npm run check` 必须通过。
