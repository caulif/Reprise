# 决策：Codex Desktop catalog 与全量会话发现

状态：accepted

## 问题

Codex Desktop 的本地线程目录与 Reprise 过去只扫描 rollout transcript 的发现模型不一致，导致项目、项目外会话及正文不可读的索引记录被遗漏。

## 决定

Codex 会话发现以本地只读 `state_5.sqlite` 的 `threads` 和 `.codex-global-state.json` 作为轻量目录来源，再与 rollout JSONL 按真实 thread ID 合并。未能读取 rollout 正文的索引记录仍作为 `catalog-only` 保留；没有项目归属的有效 thread 作为 `projectless`，不伪造 Unknown 项目。rollout 路径必须位于 sessions 根目录内且为真实文件，越界、符号链接逃逸和缺失源只产生诊断，不改变目录可见性。

Pack 的 discovery 返回完整轻量条目与正式项目目录；TUI 只在完整目录上搜索、分组和筛选，视口切片只影响绘制，不再把 `150` 当作发现上限。公共摘要仅增加可选的来源/可用性字段和正式项目目录，SQLite 私有列不向运行时、冻结或导入协议泄漏。

## 备选方案

**只扩大 rollout 扫描上限。** 这无法表达 catalog-only、项目外会话或 Desktop 的项目顺序，并且会增加启动扫描成本。

**启动时读取全部 transcript 正文。** 这会把大目录的启动成本与正文体积绑定，违反按需读取边界。

## 影响

列表发现仍是本地只读、无网络和无 Runtime 副作用；启动阶段只读取目录元数据与 bounded summary，详情和冻结路径按需读取 transcript 正文。数据库或 global state 不可用时会降级到 rollout 发现，并通过 diagnostics 解释缺失来源。若 catalog 与 rollout 都不可用，返回 `catalog-unavailable`；项目 assignment、SQLite project、workspace hint 或记录 cwd 不一致时按 assignment、SQLite project、workspace hint、记录 cwd 的优先级归属，并返回 `conflicting-project-source`，不静默覆盖。

## 验证

- `npm run build`
- `npm run check`
- `npm run verify:docs`
- Codex catalog/global state 与 151 条全量分组反向用例
- `node --test dist/test/codex-catalog.test.js`
\r\n