# 决策：CLI 查询、配置与机器协议

状态：accepted

目标批次见 [M5.2](../../plan/reprise-refactoring-execution.md#m52-cli-查询配置与机器协议)。

## 问题

无 TTY 与管道场景需要查询、配置、封存场景运行和历史对照，且 stdout 不能混入诊断。密钥若出现在 argv 会进入 shell 历史。来源若用标题或下标定位会在列表变化后指错会话。

## 决定

- 查询子命令（products、models、projects、sessions、history、events、auth、config get）先于有副作用命令；参数与退出码以 `src/core/cli-protocol.ts` 与 CLI 实现为准。
- 来源身份是 productId + sessionId，歧义时用 `--source-path`。来源产品用 `--source-product`；候选产品用 `--product` 与 `--model`，不得共用一个字段。分页用 `limit`/`cursor`（会话 cursor 为 sourcePath 或 Pack 续读令牌）。
- `--json` 与 `--jsonl` 互斥。子命令默认 JSON 单结果；`--jsonl` 只用于 prepare/run/compare 的活动与事件流，并以 `type=end` 收束。诊断写 stderr。查询成功不因所查实验失败而失败。
- 退出码：0 成功，1 副作用失败，2 用法，3 未知 ID，4 配置/能力缺失，5 写者冲突，6 取消，7 超时。
- 密钥不得作为 `--api-key`。保存配置走与 TUI 相同的 `saveHarnessModelConfig`；凭据用 `--api-key-file` 或 `--key-ref env:NAME`。`pi /login` 是交互登录，本 CLI 不代收秘密。
- `run` 的 `--source-root`/`--task-case` 与 `--scenario`（已封存 prepare 的 experimentId）互斥。`compare --experiment` 对磁盘上的终态 run 发起对照。prepare 写入 `scene.json`。

## 备选方案

**查询也走 JSONL。** 单页结果没有流终态，异常 EOF 与空列表无法区分。

**密钥作为环境变量名以外的 argv。** 会进入 shell 历史与进程列表。

**用列表下标选择会话。** 发现顺序变化后会选错来源。

## 影响

本机跨进程 cancel 见[跨终端 cancel](./2026-09-08-cross-terminal-cancel.md)。TUI 斜杠配置与选择流程属 M5.3。

## 验证

`test/cli.test.ts` 与 `test/cli-protocol.test.ts`：真实子进程 `products --json`、未知 experiment 退出 3、stderr 诊断、禁止 `--api-key`、history 查询成功。`test/architecture.test.ts`：CLI 不静态加载 TUI。反向：`--json --jsonl` 同时出现仍退出 0，或 stdout 打印密钥，则红。
