# 决策：记录下来的 Windows 路径在任何宿主上都按盘符路径比较

状态：accepted

## 问题

会话 cwd、历史写入路径和报告路径来自 Windows 上的 Codex / Claude Code。CI 的 `test` / `audit` / `coverage` 也在 Ubuntu 上跑。Node 的 `path.resolve` / `path.isAbsolute` 在 POSIX 宿主上把 `C:/source` 当成相对路径，拼到 `process.cwd()` 后面。结果是：全部 Windows 会话被 `excludedCwd` 滤掉、越界绝对路径被当成副本内相对路径、TUI 项目列表为空、覆盖率随测试失败一起掉下去。

## 决定

比较或展示**记录下来的路径**（会话 cwd、historical writes、报告/结果短路径、TUI 是否把历史 cwd 当作已填绝对路径）时，使用 `src/core/paths.ts`：盘符和 UNC 在任何宿主上都是绝对路径，且不得 `resolve()` 进当前工作目录。真正打开、复制、删除本机文件时仍用宿主的 `node:path`。

## 备选方案

**只在 Windows CI 上跑路径敏感测试。** 这会让 Ubuntu lane 变成假绿，下次有人在 Linux 上改 `excludedCwd` 或 `sessionWritePaths` 不会被挡住。

**把测试夹具改成 POSIX 绝对路径。** 夹具不再代表真实导入的 Windows 会话；`C:/source` 被滤掉或被当成相对路径的生产缺陷会重新出现。

**在每个 Pack 里各自写一份 `resolve` 包装。** 两个 `excludedCwd` 已经因此分叉一次。路径语义属于跨模块协议，收口在 `core/paths.ts`。

## 影响

- 应用层、两个 Pack 和 TUI 比较记录路径时走同一组辅助函数。
- Linux CI 能用 Windows 会话夹具验证导入与 intake，而不会把 `C:/source` 误判成仓库子目录。
- 本机文件系统操作仍要求宿主绝对路径；`C:/source` 在 Linux 上不能当真实工作区根。

## 验证

- `node scripts/run-gates.mjs test` 不再抛 `unknown dependency: test -> lint`。
- `test/paths.test.ts` 断言 `pathContainedBy(process.cwd(), 'C:/source') === false`。
- `sessionWritePaths` 对 `C:\Windows\System32\evil.dll` 返回空，只保留副本内相对路径。
- Ubuntu 上 `/intake` 能到达项目列表；`npm run test:coverage` 不因路径误判掉到阈值以下。
