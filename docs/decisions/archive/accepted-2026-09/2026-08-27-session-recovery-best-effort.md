# 决策：会话恢复按 readiness 分级，discovery 不得提前判死

状态：accepted

## 问题

列表摘要受 4 MiB / 256 KiB 窗口限制，且 Codex Desktop 使用 `response_item.payload.type=message`。摘要阶段把“窗口内没有用户消息”和损坏 JSONL 写成 `availability=unreadable` 后，Enter/freeze 不再做完整 inspect。catalog 合并还曾用单侧 `unreadable` 覆盖已经存在的 transcript。用户只能看到笼统不可读，无法区分待完整尝试、部分恢复和真正读失败。

## 决定

`availability` 只描述源文件是否存在、能否打开。`recoveryReadiness` 描述正文恢复结果：`verified`、`best-effort`、`pending`、`history-only`、`no-user-input`、`corrupt`。discovery 在 `too-large`、行数上限或摘要窗口没有用户消息时记 `pending`，Enter 必须完整 `inspect()`。完整 JSONL 逐行解析：尾部非法 JSON 保留前缀为 `best-effort`；非尾部非法 JSON 为 `corrupt` 并保留前缀与 raw；读取中途 size/mtime 变化则重试一次，第二次仍变化则为 `pending`。catalog 与 transcript 按证据强度合并：verified > best-effort > catalog metadata > missing；不得用 catalog 的 `indexed` 覆盖完整解析成功的 transcript。`isEligibleSession` 仍要求合法用户输入和完成 turn，system/developer 不得充当用户输入。每次尝试产出带诊断的恢复记录，并通过 `Value.Check(SessionRecoveryAttemptSchema)`。

## 备选方案

**继续用 `unreadable` 表示一切摘要失败。** 会把窗口外用户消息和格式未适配永久挡在 inspect 之外。

**用更大的摘要内存上限代替完整流式解析。** 把列表成本变成全量加载，无法处理仍在写入的尾部。

**缺少 session_meta 时用文件名 UUID 当作 session id。** 文件名与正文可以不一致，会冻结错误会话。

## 影响

- 列表行可以是 `pending` 而仍可 Enter；真正的权限/stat 失败才是 `unreadable`。列表 `recoveryReadiness` 不构成 `freezeBlockedReason`；冻结资格以完整 inspect 为准。
- `best-effort` 允许 freeze 可回放 TaskCase 并展示诊断；`corrupt` / `no-user-input` / `history-only` / `catalog-only` 保存证据或线索，不进入真实 replay。
- freeze 的 raw 与 hash 仍来自同一快照，不把整文件读进第二份 Buffer。

## 验证

- `test/session-recovery-best-effort.test.ts`：旧 `event_msg`、Desktop `response_item/message`、混合格式、未知 content、developer 不计 user、256 KiB/4 MiB 之后的用户消息、尾部与非尾部非法 JSON、catalog 证据优先级、session id 不一致拒绝。
- `test/session-recovery-contract.test.ts`：损坏 JSONL 留在 catalog 并带可操作诊断。
- `npm run check`
