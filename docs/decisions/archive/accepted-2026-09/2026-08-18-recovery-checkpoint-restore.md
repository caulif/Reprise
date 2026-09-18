# 决策：Recovery checkpoint capture and deterministic restore

状态：accepted

## 问题

Recovery 必须能够从任务开始前的可信基线恢复，而不是从已经被任务修改的 source 或事后 transcript 猜测。checkpoint 还必须在 Host 重启后仍可验证，否则中断后的实际恢复会退化为同进程偶然可用的能力。

## 决定

`LocalWorkspaceProvider.captureRecoveryCheckpoint` 在 Candidate 获得可写隔离副本之前复制 source tree，并写入 Provider-owned 的 content-only checkpoint。相邻的 schema-checked metadata record 保存 checkpoint ID、case ID、fingerprint 和预算；它不写入 checkpoint tree，因此不会改变内容 digest。

`beginRecovery` 只接受当前 Provider 根目录下的 checkpoint，并重新读取并校验 metadata、预算和 fingerprint。内存缓存丢失后，新建的同根 Provider 仍能验证并使用该 checkpoint。普通 Candidate 启动时记录 `recovery.checkpoint_captured` 事件，只含 checkpoint ID、tree digest 和资源数量，不记录绝对路径或内容。

当 `recoverCodexExperiment` 获得通过上述校验的 checkpoint 时，Host 不调用 Recovery 模型，而是直接把已复制到 isolation staging 的 checkpoint 作为恢复结果。Host 根据“当前 source fingerprint → checkpoint fingerprint”生成 `recovery.md`、完整 manifest 和逐路径 `artifact:checkpoint-*` evidence；这些 evidence 只包含相对路径、entry kind 和 content hash，绝不包含 checkpoint 绝对路径或文件内容。Provider 仍独立校验 source tripwire、manifest 的完整覆盖和每一路径的 checkpoint hash；只有全部通过才给出 `recovered` / `verified`。Host 记录 `recovery.checkpoint_restored`（checkpoint ID、digest、changedPathCount），并把模型调用计为 0。

checkpoint 不可信、被篡改、超预算或不属于当前 Provider/case 时，`beginRecovery` 必须拒绝，不能伪造此确定性结果；没有 checkpoint 时继续走最大努力 Agent 调查与候选恢复链路。

## 备选方案

**只用进程内 Map。** 实现较小，但 Host 重启后无法恢复，和中断场景的目标相矛盾。

**把 metadata 写进 checkpoint tree。** metadata 会改变所验证的 tree digest，导致“内容快照”同时包含可变控制数据，难以审计。

**接受调用方给出的任意 checkpoint 路径。** 会破坏 Provider ownership、路径隔离和 source 只读边界。

## 影响

checkpoint 元数据成为一个受 TypeBox schema 约束的 on-disk 格式；捕获额外增加一次受预算限制的本地复制和 fingerprint。交换的是 Host 重启后的可恢复性，以及不依赖模型的可验证基线。

有 recovery baseline 的 Candidate 不再另行捕获 source checkpoint，因为该 baseline 已有隔离的恢复证据；所有推断性写入仍只发生在 staging/candidate，源目录仍通过 tripwire 读取验证。

## 验证

`test/environment.test.ts` 以新 Provider 实例重新打开 checkpoint 并从已修改的 source 恢复，且覆盖篡改与 foreign checkpoint 拒绝。`test/codex-experiment.test.ts` 断言正常 Candidate 启动留下 `recovery.checkpoint_captured` 事件，并断言可信 checkpoint 恢复不会调用模型、生成 Host-owned evidence、保留 source 且以 `verified` 交付。`npm run check` 验证 schema、构建、lint 和全套测试。
