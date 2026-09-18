# 决策：Session discovery 按来源身份排除，不按 cwd 排除

状态：accepted

## 问题

TUI 把 `process.cwd()` 和 `dataDir` 一并传入 `excludeRoots`，Pack 再用 `pathContainedBy(root, session.cwd)` 丢弃会话。当 Reprise 从某个 Codex/Claude 项目根启动时，该项目下全部历史会话在进入列表前被删除。

## 决定

默认发现范围不依赖当前工作目录。`excludeSessionIds` 精确匹配产品 session ID。`excludeSourcePaths` 先规范化并校验位于本次 discovery root，再精确匹配 `sourcePath`；根外路径忽略。`excludeRoots` 只排除来源文件位于该目录内的候选，不得用会话 cwd 做排除键。TUI 只把 `dataDir` 作为 `excludeRoots` 传入，并可叠加本次运行记录的 `excludeSessionIds`，不得默认传入 `process.cwd()`。Codex rollout/catalog 合并与 Claude transcript/history 发现共用同一排除函数。

## 备选方案

**继续用 cwd 排除 Reprise 自己的运行会话。** 会按项目根批量删除用户历史，把防污染和历史完整性绑死在工作目录上。

**删除全部排除字段，依赖调用方事后过滤。** 会让分页 index 把不应展示的 runtime 文件算进 catalog，并让两个 Pack 再次分叉过滤规则。

## 影响

- 改变进程工作目录不得改变历史 catalog。
- 兼容包装 `discoverClaudeSessions(..., excludeRoots)` 仍可用，但语义改为来源目录排除。
- Reprise 发起的 runtime session 必须靠记录下来的 ID 或精确 source path 排除。

## 验证

- `test/session-discovery-exclusion.test.ts`：cwd 等于 `process.cwd()` 的 Codex/Claude 会话首次 discovery 必须返回；`excludeSessionIds` / `excludeSourcePaths` 只去掉指定项；TUI query 不含 `process.cwd()`。
- `test/claude-code-pack.test.ts`：cwd 落在 `excludeRoots` 内的 transcript 仍被发现。
- `test/paths.test.ts`：`sameFsPath` 在 Windows 盘符与 POSIX 分隔符下等价。
