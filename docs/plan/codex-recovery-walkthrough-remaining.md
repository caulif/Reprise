# 走查后仍成立的恢复缺口

状态：完成  
后续工作：[2026-08-31 走查后的恢复修复](./codex-recovery-20260831-fix.md)。  
范围：同一次 Codex 历史会话走到确认页后仍成立的缺口。不扩大为候选 Runtime、冻结 `initialInput`、跟随出根 symlink。  
依据：[TUI](../product/tui.md)、[无 accept 不得开跑](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md)、[partial 允许额外路径](../decisions/accepted/2026-08-30-recovery-partial-extra-paths.md)、[后一次完成信封不得覆盖已探测通过的信封](../decisions/accepted/2026-08-31-recovery-keep-last-valid-envelope.md)、[环境与 Recovery](../architecture/environment.md#71-内部工作空间与实际边界)、[上一轮走查修正](./codex-recovery-walkthrough-followup.md)、[A–F 修正](./codex-real-session-recovery-correction.md)。

## 1. 要变成真的事

同一次真实会话走到确认页时，除已落地的列表题目、确认页自洽、Git `isRepo=false`、删除次数上限外，还必须成立：

1. **弱证据可看**：第一次 TypeBox 通过的 `partial` 与实际变更（走查里 16 条已删路径、Verifier `pending_user_review`）必须变成可审查 preview（`hasAccept=true`）。后续 readiness 轮即使再写出一份 TypeBox 通过的信封，只要 Provider 校验失败，也不得把整单改成 `current_state_fallback`。
2. **删除空转停调查**：`delete_file` 累计上限达到后，只允许完成工具；不得继续把调查预算耗在同一上限错误上。
3. **时间线不刷屏**：同一 Host 诊断（删除上限 / 调查预算耗尽）在画布上合并，操作者能看见「已删 N 条、Git 不是仓库」，而不是几十行相同失败。
4. **确认页讲人话**：有 preview 则为部分恢复、限制可见、可开跑；无 preview 才是无法恢复。诊断码旁要有一句中文原因（校验拒绝 / 预算耗尽），禁止只显示 `provider_validation_failed`。

Done means：`npm run check` 通过；触及 TUI 则更新 `docs/tui-audit/frames/`；新门禁带反向用例；不启动真实候选 Runtime。

## 2. 非目标

- 改冻结契约「第一条用户消息永远是 `initialInput`」。
- 跟随出根 `node_modules`、放宽快照、开放 shell、提高无界调查预算。
- 弱证据自动 `acceptRecovery` 并默默开跑。
- 改 Discovery「待完整解析」徽章语义，或产品列表打开前就把顶栏点成 Codex。

## 3. 仍成立的缺口（按层）

### 3.1 Host：后一次完成信封覆盖前一次

[环境](../architecture/environment.md#71-内部工作空间与实际边界)要求：readiness 反馈轮若**模型请求失败**，保留上一份已通过 TypeBox 的完成信封。走查里第二次会话**完成**了，Host 把它写成 `lastCompletedRecovery`，再拿它去做 Provider 校验。第二份信封声称删除都失败；校验拒绝后整单 fallback。第一次会话已经删了 16 个文件、Verifier 为 `pending_user_review`，用户看不到 `accept`。

[partial 额外路径](../decisions/accepted/2026-08-30-recovery-partial-extra-paths.md)只覆盖「manifest 漏报路径」；这次失败模式是「后一次完成信封取代前一次可校验信封」。

### 3.2 Host：删除上限挡不住继续调用

累计 16 次之后第 17 次 `delete_file` 会失败，但调用仍计入调查预算。模型继续对每个路径再调一次，直到调查预算 64 耗尽。readiness 循环看到的不是「删除上限」，不会停。

### 3.3 TUI：失败行按事件逐条投影

时间线把每一次 `agent.tool_failed` 画成一行。上限错误与预算耗尽各出现几十次。`inspect_git_history` 的 `isRepo=false` 在 audit `details` 里，画布上几乎看不到。

### 3.4 确认页：终态码对用户不友好

拦截开跑、标题和环境行已经与 `hasAccept=false` 一致。操作者仍只看到英文 `provider_validation_failed`，不知道 Verifier 要人看、也不知道 staging 被丢掉。

## 4. 批次

| 批次 | 主题 |
|---|---|
| N | 校验失败时保留上一份已完成 `partial` 信封与 staging，再 `validateRecovery` |
| O | 删除上限达到后只允许完成工具，并停止 readiness 反馈 |
| P | 连续相同恢复失败在时间线合并；Git `isRepo=false` 可见 |
| Q | 确认页中文原因；有 accept 则为部分恢复 |

回滚：还原对应源文件、测试、frames 与 ADR。

---

### N — 后一次完成不得作废前一次可校验信封

`runReadinessFeedbackTurn` 在新会话 `status===completed` 时，先对**当前 staging** 试 `validateRecovery`（或等价的证据+manifest 预检）。失败则：

- 恢复 `session.recovery = previousCompleted`；
- 保留 staging，不走 `current_state_fallback`；
- 记一条 `recovery.warning`（后一次信封校验失败，沿用上一次完成信封）。

仅当**没有任何**已完成且能通过 Provider 校验的信封时，才 fallback。同一次变更写 `docs/decisions/accepted/`：放弃「后一次 TypeBox 通过的完成信封一律覆盖前一次」。

**验收**：fixture：第一次 `partial` + 实际变更且校验通过；第二次完成信封证据/manifest 故意无效。结果：`hasAccept=true`，用户终态部分恢复。反向：只有一份无效完成信封 → 仍 fallback、无 accept。

### O — 删除上限结束调查

`delete_file` 累计超过 16 之后：抛错且**不再计入**调查次数（或直接视为调查预算耗尽）。`lastToolFailureCategory` 记为删除上限，`enforceRecoveryReadiness` 不得再开反馈轮。完成工具仍可写 report/manifest。

**验收**：第 17 次 delete 失败后，第 18 次不得再消耗调查预算；readiness 不得因 `not_ready` 再开一轮模型。反向：第 16 次仍成功。

### P — 时间线合并相同失败

投影层对连续相同的 `Recovery tool failed` 文案（含同一 `delete_file` 上限句）合并为「×N」。`inspect_git_history` 完成且 `details.isRepo===false` 时，可见一行「不是 Git 仓库」，不得 hidden。

**验收**：widgets/timeline：34 条相同上限错误只占一行计数；非仓库 inspect 完成帧含「不是仓库」。反向：两条**不同**失败文案不得合并。

### Q — 确认页原因句

有 `accept`：状态为部分恢复，限制列出 unresolved / extra paths，允许开跑。无 `accept`：无法恢复；`failureStage` 映射为中文短句（校验未通过、删除预算用尽），英文码只作次要字段。

**验收**：recovery-ui：`hasAccept=true` 的 partial 不得匹配「无法启动」；`hasAccept=false` 不得只显示英文 stage、不得含「对照从隔离开始」。

## 5. 刻意不做

列表 `[待完整解析]`、助手信号 `a0`、产品页打开前顶栏仍空心：不阻塞恢复正确性，不列入本计划。
