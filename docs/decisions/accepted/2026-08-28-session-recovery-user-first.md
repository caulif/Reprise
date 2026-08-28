# 决策：会话恢复对用户只暴露终态，环境检查在后台完成

状态：accepted

## 问题

选中会话后先进入环境检查。workspace 中的 symlink/junction 使指纹和复制直接失败，TUI 显示「无法继续」且不创建隔离候选。用户把环境准备失败理解成会话没有恢复。Transcript 冻结、workspace 复制和 Recovery Agent 执行被合成同一种界面错误。

## 决定

选择会话并冻结 TaskCase 后立即进入 recovering，不把 preflight 当作用户确认门槛。`blockedReasons` 只保留无法安全复制的预算超限；symlink/junction、权限和无法证明安全的链接写入 `excludedEntries` 并继续复制其余普通文件。source root 内可解析的链接物化为普通文件；root 外、缺失、循环的链接跳过。没有安全候选时不在真实源目录上运行模型，仍保存已冻结 transcript 与 `recovery-diagnosis.json`。用户主界面只显示「已恢复」「部分恢复」「无法恢复」。Recovery Agent 只接收已固定的 TaskCase、Provider 候选和这些环境事实，不解析产品 JSONL，不写入用户原始 workspace，不伪造用户输入。

## 备选方案

**删除 symlink 检查并递归跟随。** 会把恢复范围扩到 root 外，并在候选中留下指向真实目录的可写链接。

**把真实 workspace 交给 Recovery Agent。** 违反隔离与 source tripwire。

**环境失败时伪造用户 prompt 或把失败显示为已恢复。** 无法审计，也无法重试。

**继续把 preflight `blockedReasons` 当作进入恢复页的门禁。** 一个 junction 就会让用户看不到任何恢复尝试。

## 影响

- Provider 指纹与复制共用同一套链接处置；部分 workspace 仍可 `beginRecovery`。
- RecoveryContext.staging 携带 `excludedEntries`，并写入 `recovery.started` / `recovery.model_input` 审计。
- 每次尝试持久化 `recovery-diagnosis.json`（`Value.Check(RecoveryAttemptDiagnosisSchema)`）。
- TUI 恢复页展示会话、项目和阶段；确认页标题为三种用户终态。

## 验证

- `test/environment.test.ts`：junction 跳过并复制其余文件；in-root 文件链接物化为普通文件。
- `test/recovery-user-status.test.ts`：三种用户终态。
- `test/widgets.test.ts`：recovering 页与确认页终态文案；错误页不再使用「无法继续」。
- `test/snapshots.test.ts`：Recovery system prompt 含 staging 排除事实。
