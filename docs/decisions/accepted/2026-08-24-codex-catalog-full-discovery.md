# 2026-08-24：Codex Desktop catalog 与全量会话发现

## 状态

已接受。

## 决策

Codex 会话发现以本地只读 `state_5.sqlite` 的 `threads` 和 `.codex-global-state.json` 作为轻量目录来源，再与 rollout JSONL 按真实 thread ID 合并。未能读取 rollout 正文的索引记录仍作为 `catalog-only` 保留；没有项目归属的有效 thread 作为 `projectless`，不伪造 Unknown 项目。rollout 路径必须位于 sessions 根目录内且为真实文件，越界、符号链接逃逸和缺失源只产生诊断，不改变目录可见性。

Pack 的 discovery 返回完整轻量条目与正式项目目录；TUI 只在完整目录上搜索、分组和筛选，视口切片只影响绘制，不再把 `150` 当作发现上限。公共摘要仅增加可选的来源/可用性字段和正式项目目录，SQLite 私有列不向运行时、冻结或导入协议泄漏。

## 兼容与降级

SQLite 表缺失、列版本未知、文件损坏或 global state JSON 无法验证时，读取器返回诊断并继续使用 rollout scanner。冻结、导入和详情检查仍只读取用户选择的 rollout 正文；列表发现不访问凭据、不联网、不启动 Runtime。

## 验证

- `npm run build`
- Codex catalog/global state 与 151 条全量分组反向用例
- `node --test dist/test/codex-catalog.test.js`
