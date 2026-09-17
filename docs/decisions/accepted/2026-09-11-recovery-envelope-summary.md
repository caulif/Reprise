# 决策：Recovery 信封 summary 与 seed 同构

状态：accepted

承接 [单工作副本自主三轮循环](./2026-09-09-recovery-single-workspace-agent-loop.md) 与 [稀疏 source mount](./2026-09-11-recovery-sparse-source-mount.md)。

## 问题

两态信封缺少面向操作者的一句话结论；Host 曾用 `current_state_fallback` 标记新的 blocked/失败结果；checkpoint 物化曾绕过 Recovery Agent。

## 决定

最终信封为 `ready` 或 `blocked`，并带一句话 `summary`（1–240 字符、无换行、至多一个句末标点）。最后一轮同时写 `recovery.md` 与 summary，不增加 LLM 调用。Host 原样持久化 Agent 文字，不改写。`blocked` 的 `unresolved` 非空；`ready` 可保留不影响任务的缺口。

模型传输、输出修复或可修复机械反馈保留同一 Session 与 workspace；workspace 损坏或不可恢复的进程边界错误才 `resetRecoveryWorkspace` 并 `releasePreparation` 从 Turn 1 重启。source tripwire 失败关闭。

生产路径新写入的 `recovery.status` 只使用 `ready` / `blocked` / `failed`。新的 `match`：`ready` 为 `recovered`，blocked 与失败为 `observational`。历史磁盘上的 `partial`、`insufficient_evidence`、`current_state_fallback`、`recovered_partial` 只读兼容。

## 备选方案

**Host 改写或截断 summary**：界面整齐，但把操作者可见结论从 Agent 转到 Host。

**checkpoint 继续走 Host 直通**：省模型调用，但与「物化优化不得绕过 Agent」冲突。

**失败一律重置工作区**：实现简单，但会丢掉已完成的侦察与修复。

## 影响

schema、Agent 输出契约、baseline marker、TUI 确认页和场景加载都携带 `summary`。代码、文档、表格、幻灯片、媒体和调研任务共用同一 Recovery 流程；Git 只是可按需读取的材料。

## 验证

空 / 超长 / 多句 summary 与 blocked 空 unresolved 不能通过信封校验。source 只读覆盖变量、别名、相对路径、junction 与 PowerShell 变体。checkpoint 种子会调用 Agent。传输失败不 `releasePreparation`；workspace 损坏会重启。G1 风格超预算源仍能启动 Agent。`test/core/architecture.test.ts` 禁止生产路径新写旧三态与 Host checkpoint 短路。相关 Recovery 测试与 `npm run check` 必须通过。
