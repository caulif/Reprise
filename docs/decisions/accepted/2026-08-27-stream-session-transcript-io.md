# 决策：会话正文流式读取，catalog 只读固定头

状态：accepted

## 问题

Codex catalog 用 `readFileSync` 再 `slice` 校验 `rollout_path`，会把每个 transcript 整文件读进内存。本机约 1360 个 rollout、合计数 GB。inspect/import 另有 64 MiB 上限，真实可读会话因此无法 freeze。cwd 与 TUI 分组使用双向目录包含，会把父目录会话归到任意子项目。损坏 JSONL 使用合成 ID，无法与 SQLite 真实 thread ID 合并。

## 决定

Catalog 用 `openSync`/`readSync` 只读文件头（256 KiB）。discovery 先扫描 rollout，把 `sessionId→path` 交给 catalog；已覆盖的路径不再打开文件。inspect 单次流式遍历累计 metadata、transcript、signals 与 behavior，不另存 raw 行数组；import 在同一遍把解析对象写入 `historicalEvents`（TaskCase 契约），不再复制一份 `rows`。raw 用文件流复制；freeze 先把源文件复制到临时快照再哈希，再用该快照写入 case，因此 `contentHash` 与落盘 raw 是同一份字节。JSONL 诊断行号使用物理行。取消 64 MiB 拒绝。cwd 只匹配「项目根包含会话 cwd」，并选最长根；workspace hint 仅在唯一子项目时允许父路径。损坏 JSONL 使用头部真实 ID 时按 ID 与 canonical path 合并；摘要失败不得用单个 `unreadable` 覆盖更强的 transcript 证据，见[会话恢复按 readiness 分级](./2026-08-27-session-recovery-best-effort.md)。

## 备选方案

**保留 64 MiB，只在列表上标 oversized。** 状态诚实，但用户要求所有可读会话都能恢复。

**整文件读入后再截断。** 不能降低首次 catalog 的内存与主线程阻塞。

**cwd 继续双向包含。** 父目录会话会落到迭代顺序中的任意子项目。

## 影响

- 列表摘要仍受 4 MiB / 50,000 行约束；完整恢复不再按文件体积拒绝。
- 超大会话的 `historicalEvents` 与 transcript 仍会驻留内存，这是 TaskCase 契约；inspect 不得同时保留 raw 行数组，import 不得再复制一份 `rows`，raw 禁止第二份完整 Buffer。
- freeze 的哈希对象是源文件复制完成后的临时快照。

## 验证

- `test/session-review-fixes.test.ts`：固定头字节数、父目录/sibling/嵌套根、损坏尾部与 SQLite 合并、超过 64 MiB 的 Codex/Claude JSONL 可 inspect/freeze、JSONL 物理行号、freeze 快照哈希与 raw 一致。
- `test/codex-pack-sessions.test.ts`：超大 rollout 不再以 64 MiB 上限失败。
- `npm run check`
