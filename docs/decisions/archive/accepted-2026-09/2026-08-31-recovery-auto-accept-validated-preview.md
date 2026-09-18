# 决策：Provider 校验通过的恢复 preview 由 Host 自动接受

状态：accepted

## 问题

校验通过的 partial / recovered preview 仍要操作者再执行 `acceptRecovery`，才能发布 baseline。走查里人闸变成第二道「信不信 Agent」；与「恢复 Agent 的工作区判断以 Host 校验为准、操作者只确认是否开计费候选」不一致。

## 决定

`validateRecovery` 成功得到 preview 后，Host **立即** `acceptRecovery` 并发布 canonical baseline（`acceptedAutomatically`）。不要求 readiness `ready`，也不要求 Verifier `verified`。没有通过校验的 staging 仍不得发布，确认页仍禁止在无 baseline 时启动候选。是否启动隔离 Candidate Runtime 仍由确认页 Enter 决定（费用与进程）。

## 备选方案

**仅 `ready_for_task` 才自动接受。** 弱证据 partial 永远停在人闸，预览容易在后续轮被作废。

**自动 accept 并立即启动候选。** 把计费进程也交给恢复结束事件，没有确认页的费用警告。

**弱证据跳过 Provider 校验再 accept。** 放弃证据引用与 manifest 约束。

## 影响

`pending_user_review` 且校验通过时也会发布 baseline。确认页有 accept / 已发布根时按部分恢复或已恢复开跑。取代「禁止弱证据自动 accept」作为当前接受策略。

## 验证

`test/codex-experiment-recovery-envelope.test.ts` 与 `test/codex-experiment-recovery-effort.test.ts`：校验通过的 partial 带 `acceptedAutomatically`，baseline 根在 `baselines`。反向：探测失败的唯一信封仍无 accept。`npm run check`。
