# 决策：partial 变更路径以 fingerprint 为准

状态：accepted

## 问题

Provider 要求 Agent 申报的 manifest 路径与信封 `evidenceRefs` 对齐。走查里 Agent 已删除 16 个文件，信封只抄了 3 个 ref，整单 `provider_validation_failed`，没有 preview。Host 当时已经有 fingerprint 差。

## 决定

`validateRecovery` / `probeRecovery` 用 fingerprint 差（忽略 `.git/` 与已摘除的 `recovery.md`）作为变更路径的唯一来源，由 Host 合成内部 manifest。`partial` 不因「信封 refs 不是 Agent 清单的子集」失败；未知 Agent ref 在全部无法对应冻结 catalog 时拒绝（伪造不得进入 published baseline），其余丢弃。弱证据（仅 Host 观察到删/改）足够 `partial` preview。`recovered` 每条路径仍要强证据。`insufficient_evidence` 时 staging 须与源 capture 一致。无变更却声称 `recovered` 拒绝。校验成功则按已有决策自动 accept；失败则 fallback、无 accept。

## 备选方案

**让模型把信封 refs 写全。** 走查已失败。

**校验失败仍 accept。** 放弃 Provider 边界。

## 影响

Agent 信封不再要求 `manifestPath`。`partial` 允许空 `evidenceRefs`。取代「manifest 与 fingerprint 双向全等」作为 partial 的路径契约；`recovered` 仍要强证据覆盖每条变更路径。

## 验证

`test/environment.test.ts`：删除若干文件且信封 refs 不全或为空时 `partial` 仍 preview。反向：无变更 `recovered` 拒绝；仅伪造 `event:not-owned-ref` 拒绝。
