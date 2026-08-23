# 会话列表 partial 摘要与进程内增量缓存

- 日期：2026-08-23
- 状态：accepted

## 背景

会话发现的完整摘要仍受 4 MiB / 50,000 行限制。超限文件不能因为列表扫描而被误报为可导入，但其头部可能包含足够的 session id、cwd 和首条用户消息来形成安全的列表项。原有摘要索引按整体 fingerprint 缓存，单个文件变化会导致所有文件重读。

## 决策

`SessionSummary` 增加可选 `partial` 标志。共享发现层在完整摘要因 `too-large` 失败时，可调用 Pack 提供的有界头部摘要 consumer；只有能确认合法 session id 和列表级身份的结果才进入 `items`，并标记 `partial: true`。无法安全确认身份的文件继续保留现有 `too-large` diagnostic。

缓存仍只存在进程内，最多保留四个产品/root 索引。索引按绝对路径、文件 size 和 mtime 复用单文件结果；新增、删除、截断、替换或元数据变化的文件重新摘要。cursor 仍绑定 root 与完整排序 fingerprint，变化时返回 `stale-cursor`。

## 边界与兼容性

- `partial` 只描述列表摘要不完整，不改变 inspect/import 的完整文件限制，也不承诺可回放。
- 有界读取不消费模型正文或工具输出；不读取凭据、不联网、不启动 Runtime、不落盘索引。
- 旧 Pack 不提供 partial consumer 时行为保持原样；新字段可选，旧消费者忽略它。
- refresh 只清除对应产品/root 的内存缓存。

## 验证

- `test/session-discovery-page.test.ts` 覆盖未变化文件复用、变更文件单独重算和 too-large 安全 partial 反向路径。
- Codex Pack 继续覆盖超限文件无法安全摘要时保留 `too-large`。
- `npm run build` 与受影响 discovery/TUI 测试通过。
