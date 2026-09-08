# 规划：2026-09-08 墨水屏走查后的修复

走查正文在本机 `docs/.local/reprise-run-2026-09-08/测试记录.md`（不受控）。本文件是受控任务表：按优先级改 Host、隔离输入、TUI 与对照，不把全盘读权交给 Agent。

## 完成判据

- Controller / Comparison 在「`<think>` + 合同样例 + 文末合法对象」时能抽出最后一个合法 JSON 对象。
- `evidenceRefs` 里不合 `event:`/`artifact:` id 模式的项被丢掉后，其余字段合法则决策通过；目录里不存在的合法 id 仍拒绝。
- 相对路径里的 `\` 按 `/` 解析；绝对路径仍拒绝。
- 冻结用户句里、位于历史 cwd **之外**、且文件仍存在的附件拷进副本 `imported-inputs/`，不开放全盘工具。
- 确认页模型行以 **resolved** 为主标签；部分恢复有一句「不是任务零点」。
- 对照失败页带 `code`/`category`/`attempts`；`shell_exec` 描述写明只读挂载禁止写。
- `__pycache__` / `.pytest_cache` 不进候选改动主列表。
- `failed.controller` 的 `failure.code` 与 Host `invalid_output` 一致。
- `npm run check` 通过。反向：think 包裹仍应抽出对象；`dir\\file` 相对路径可读；绝对 `C:\` 仍拒。

## 本批实施

| id | 问题 | 改哪里 |
|---|---|---|
| H1 | 抽 JSON 从首 `{` 切到末 `}`，think 样例污染文末对象 | `pi-agent-host` `parse`：去掉 think，收集可 parse 对象，取最后一个 |
| H2 | 路径型 evidence ref 整单失败 | Controller `normalize`：丢掉模式不合法的 ref |
| H3 | Windows 反斜杠相对路径 | `workspaceRelative` 先把 `\` 换成 `/`，绝对路径仍拒 |
| I1 | TEMP 剪贴板图未进副本 | `importExternalTaskInputs`：只拷用户句点名的、cwd 外的现存文件 |
| U1 | 确认页 `sonnet` 盖住 MiniMax | 模型列表 note 与确认行：resolved 优先 |
| U2 | 部分恢复时间轴 | 确认页一句：副本不是任务开始零点 |
| C1 | 对照失败页只有 `invalid JSON` | 失败 HTML 写 code / category / attempts |
| C2 | Comparison 对只读树 `shell_exec` | 工具描述写死只读挂载与可写目录 |
| F1 | pytest 缓存算改动 | `candidateChangedPaths` 过滤 |
| F2 | record 写成 `agent_failure` | `terminationFor` 保留 Host `invalid_output` |
| V1 | `<think>` 进时间线 | `visibleAssistantText` 去掉 think 后再判信封 |

## 不在本批

- 全电脑任意读：秘密与越界风险；输入只走冻结点名文件。
- Recovery `oldText` 失败与 `pi_compact`：部分恢复语义保留，不改 playbook。
- 把 History 后置用户句改成强制重放队列。
- Harness `turns=1` 对 Claude 原生 33 回合：公开计数仍是 settled turn；原生次数可以后进 facts。
- 运行页「正在启动 / 长时间无事件」：需真终端复现，本批不改帧基线。
- 放宽 evidence **目录**校验（未知 `event:uuid` 仍失败）。

## 依赖

H1/H2 同一 Host 解码器，Controller 与 Comparison 共用 parse。I1 必须在 `beforeFingerprint` 之前写入，避免附件被算成候选改动。协议变化见 [Host 决策抽取](../decisions/accepted/2026-09-08-host-decision-json-extraction.md)。
