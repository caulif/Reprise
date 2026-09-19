# 决策：冻结时发现 historicalCwd 的嵌套 Git

状态：accepted
日期：2026-09-16

## 问题

冻结只对 `historicalCwd` 根做 `rev-parse --is-inside-work-tree`。仓库若在子目录（如 `caulif/.git`），Case 写成 `cwd.git.isRepository=false`，且没有嵌套仓记录。Codex 的 `historicalCommit` 只来自 `session_meta.git.commit`；该字段缺失时 Host 没有任何 HEAD 线索。

## 决定

冻结导入时对 `historicalCwd` **及其子目录** 发现 Git。根目录是否仓库仍写 `taskContext.historicalEnvironment.cwd.git.isRepository`（及根 HEAD / dirty）。子目录仓库写入同一 `git` 对象的 `nested` 数组：`relativePath`（相对 `historicalCwd` 的 POSIX 路径）与可解析的 `head`。不把嵌套 HEAD 抄进 `historicalCommit`。仅当 `session_meta` 带有合法 `git.commit`（及既有别名）时写入 `taskContext.historicalCommit`。符号链接 `.git` 跳过。不新增 TaskCase 顶层字段；嵌套记录留在已有 `taskContext` JsonRecord 内，发布前 `Value.Check(TaskCaseSchema)`。

## 备选方案

**只信 session_meta.git.commit。** N6 样本没有该字段，Case 仍看不见 `caulif`。

**把嵌套 HEAD 当作 historicalCommit。** 混淆「会话元数据钉住的 SHA」与「冻结时磁盘上的当前 HEAD」。

**复用 Git sink 的发现实现。** Pack 不能依赖 environment 层；sink 还处理越界 gitdir 与隔离，超出冻结线索范围。

## 影响

[环境](../../architecture/recovery.md) 的会话线索包含嵌套仓。Recovery 规则 5（任务前 HEAD / `ready`）仍另批；本决定只保证 Case 能看见仓库位置与 HEAD。旧 Case 缺 `nested` 时行为与冻结当时一致，不回写。

## 验证

`test/products/codex-pack-sessions.test.ts`：根目录非 Git、子目录 `caulif/.git` 时 Case 的 `historicalEnvironment.cwd.git.nested` 含 `caulif` 与 HEAD；无 `session_meta.git.commit` 则没有 `historicalCommit`。既有冻结用例仍要求 meta 中的 commit 进入 `historicalCommit`。反向：该夹具下 Case 仍只有 `isRepository: false` 且无 `nested` 则红。`npm run build` 后测 `dist/`。
