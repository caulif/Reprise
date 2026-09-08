# 决策：只读历史校验、场景与 run 分属、无交互不挂对照

状态：accepted

## 问题

CLI/TUI 历史入口另读一份不校验 checksum 的事件文件，可用 `../` 越出 experiments。无交互 run 设置 `deferComparison` 却从不 `skipComparison`，结果 Promise 不结束。失败 run 仍退出 0。同一 scene 第二次写入不可变 `experiment.json` 的 `runIds` 冲突。独立对照装配候选 Runtime 并固定 `runIds[0]`。

## 决定

只读入口与 writer 共用同一套 committed 解析：完整行校验 schema、checksum、连续 sequence；无换行的尾视为未提交，保留已提交前缀；完整坏行停在该序号并诊断，不跳过。业务 ID 先过 `SAFE_ID`，再解析到 `dataDir/experiments/<id>`，路径必须仍在该目录内。

无交互 CLI 默认不进入对照等待门；`--compare` 才对照。活动在应用已知 experimentId/runId 后、长副作用前注册，JSONL 先写该 `op-…`。`--product` 与 `--model` 必须同时出现。外部 `AbortSignal`、SIGINT 与 handle.cancel 接到同一 AbortController。发布控制端点完成后再宣告可取消。

`experiment.json` 只保存不可变 spec，已存在则不再写入。候选 preflight 写在 `runs/<runId>/preflight.json`。run 索引来自 `runs/` 目录（旧文件中的 `runIds` 仅作缺目录时的回退）。独立对照只打开已保存 store、快照与 Comparison 模型，不 `findProductPack` 候选 Runtime。

`history` 与 `events` 不加载 Pack。sessions 列表把 Adapter 的 `nextCursor` 原样交还。

## 备选方案

**覆盖写 experiment.json。** 旧 run 索引消失，违反不可变规格。

**对照继续复用执行收尾整包参数。** 删掉候选 Pack 后无法出报告，多个 run 无法指定对象。

**坏行跳过继续读。** 静默接受篡改 payload，History 不能当证据。

## 影响

`parseCommittedEventLog`、CLI headless、场景二次运行、persisted compare、TUI 历史打开共用上述边界。TUI 仍可用 `deferComparison` 询问是否对照。

## 验证

篡改 checksum 的 committed 行被拒绝；无换行尾仍能读前缀；`../outside` 失败。默认 `run` 在 mock `deferComparison` 工作流上不再悬挂（CLI 不再设置该标志）。同一 `experiment.json` 第二次 start 不抛 immutable。对照入口在未知 productId 时仍能对已保存 run 调 Comparison。反向：合法 `SAFE_ID` 仍可读；`--compare` 仍等待对照完成。
