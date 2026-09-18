# 决策：Recovery 使用冻结观测引用与显式 current-state fallback

状态：accepted

## 背景

Recovery 过去只接受产品原始 `eventId`、artifact、preimage 或 Git commit 作为 evidence ref。真实导入的历史行可能没有顶层 ID，导致模型从 `read_observation` 读到内容后仍不能引用该内容；无 HEAD 的 Git 仓库也会在 facts preflight 被错误归类为失败。`insufficient_evidence` 则被投影为 `matched`，容易被误读为已验证恢复。

## 决定

Recovery 在每次运行时从冻结的 transcript 和 historical events 生成 `event:<source>-<index>-<contentHash-prefix>` 引用。索引和内容 hash 由 Host 计算，模型只能选择，不能构造。`read_observation` 返回内容时必须同时返回同一引用。该 catalog 是运行时派生数据，不改变已冻结 case 的 on-disk 格式；历史 case 允许 transcript 为空，以支持 history-only 导入。

Git 的仓库、HEAD 与 status 分开探测。unborn HEAD 是 `isRepo=true`、`headState=unborn` 的可调查状态，而不是 Agent failure。`insufficient_evidence` 只在 staging 完全未变时可通过，并一律投影为 `current_state_fallback`；任何异常 fallback 都记录结构化 failure stage 且 `accepted=false`。

## Recovery manifest

`recovery.md` 是人类解释层；`recovery-manifest.json` 是 Provider 读取并以 TypeBox 校验的机器验证层。`recovered` 和 `partial` 都必须写 manifest；每个 candidate-visible changed path 只能出现一次，并且与 Provider 的 before/after fingerprint 双向相等。每个 action 的 ref 必须同时属于最终 envelope 和冻结 catalog。manifest 路径只允许 slash-relative staging 路径，拒绝 traversal、反斜杠、绝对路径和 `.git` 元数据。

文件 action 可以带 `beforeHash` / `afterHash`；Provider 会将给出的 hash 与实际树分别复核。`recovered` 的每个变更 action 必须有路径级强证据：匹配的已验证 preimage，或能由同一 Git commit 读取、且 digest 与结果文件一致的 blob。没有这种覆盖时只能返回 `partial`（并披露 unresolved）或 `insufficient_evidence`。`.git` 内部状态不属于候选可见工作区，因此不计入 changed paths，也不得进入 manifest。验证后 report、manifest 和临时 HOME 都从将发布的 workspace 移除。

## 后果

- 有观察内容的模型可以返回可验证的 Host-owned ref；未知 ref 仍由 Agent validator 与 Provider 拒绝。
- 空 catalog 且没有可用恢复证据时，编排直接生成受控 `insufficient_evidence`，不启动模型调用。
- 报告、TUI 和后续 Provider 语义不得把 current-state fallback 称为 matched 或 recovered。
- report 的自然语言不再能单独证明恢复有效性；manifest 路径、digest 和强证据不一致时 Provider 会丢弃 staging。
- 部分恢复可以使用弱 observation ref，但必须保留 unresolved；完整恢复不能仅靠弱 observation。

## 验证

`test/recovery-tools.test.ts` 覆盖 id-less historical rows 的稳定引用、observation ref 闭环、unborn Git/非 Git 和非法 manifest 路径；`test/codex-experiment.test.ts` 覆盖空 catalog 的零模型调用；`test/environment.test.ts` 覆盖 current-state fallback、Git path/hash 强证据、manifest 漏报、多报、未知 action ref 与“报告正确但工作区未恢复”的拒绝。
