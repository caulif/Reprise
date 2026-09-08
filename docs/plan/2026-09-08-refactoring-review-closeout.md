# 规划：重构评估 R1–R4 收口

评估原文在本机 `docs/.local/reprise-refactoring-review-2026-09-08.md`（不受控）。本文件是受控任务表。

## 完成判据

- 无交互 `reprise run` 在候选结束后退出，不悬挂对照门；`--compare` 才跑对照。
- 失败 run 的 CLI 退出码非 0；JSONL 先 `activity` 后事件；`--product`/`--model` 必须成对。
- `events`/`history` 只读 committed 前缀：校验 checksum 与序号；未提交尾不挡住前缀；坏行报位置；`experimentId` 必须 `SAFE_ID` 且不得越出 `experiments/`。
- 同一 scene 第二次 run 不改写不可变 `experiment.json`；preflight 归 `runs/<runId>/`；对照按 runId，不加载候选 Runtime。
- `history`/`events` 不加载 Product Pack。
- 当前回合可见 narrate 保留；只折叠工具组；fold 沿用条目 lane。
- Pack 装配拒绝缺方法的 runtime/import 导出。
- 搜索定位命中并保留周围条目；阅读位置含条目内偏移。
- 准备页不显示伪完成比例条；运行页不伪造调查→修改阶段条。
- `npm run check` 通过。

## 本批不声称关闭

- 真实付费模型请求边界与 `streamFn` 逐次 context 对拍（需 opt-in）。
- 三 OS 真终端 IME 与 Runtime smoke。
- Controller 能力 lane 付费复跑。

## 批次

| id | 工作 |
|---|---|
| R1 | 日志 reader、路径、CLI 退出/活动/SIGINT 与 signal、默认不 defer 对照 |
| R2 | experiment spec 一次写入、run 级 preflight、对照不拼 Runtime |
| R3 | sessions 游标交给 Adapter；`import`/`inspect` CLI；TUI 工具折叠 |
| R4 | Pack 方法校验；删除无调用兼容别名 |

协议见 [实验身份与只读历史](../decisions/accepted/2026-09-08-committed-history-and-run-ownership.md)。
