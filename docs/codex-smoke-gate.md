# Codex smoke gate 记录模板

本模板用于真实 Codex 纵切片的人工验收记录。`CodexRuntimePort` 现已使用当前 Codex app-server JSONL 协议启动线程、提交 turn、等待 native settlement，并在 stop 时关闭进程；它拒绝所有 app-server 发起的工具或权限请求。不要用 fixture 记录冒充真实 smoke。

## 已验证的 protocol smoke

在 2026-08-10，使用当前 Codex 账号完成了一次有界 protocol smoke：候选为 `gpt-5.6-luna` / `high`，Controller 和 Comparison 为 `gpt-5.6-terra` / `medium`。记录包含两次 candidate admission/settlement、一次 Controller 决策、完整 append-only trace、`RunRecord`、静态报告及不可变 acceptance JSON。

该 smoke 使用 Reprise 生成的非历史文本任务，因此只证明端口、隔离、结构化 Agent 与证据链；它**不**替代下列历史任务准入条件，也不证明模型质量或比较结果。Comparison 输出按 schema 和 evidence refs 校验；模型每次输出不保证可解析，失败时报告安全降级为持久化事实。

## 已验证的历史 C 纵切片

在 2026-08-10，Reprise 从 `C:\DaoFocus` 的 `9752d2b` 冻结 source archive，并在独立临时 workspace 重放历史 C（storage / quotes）任务。Luna/high 只修改四个允许源文件；聚焦测试为 2 files / 12 tests 通过，全量测试为 9 files / 52 tests 通过。scope artifact 记录 4 个允许源码路径、1 个运行时缓存路径、0 个越界路径，patch artifact 已保存。

本次真实运行共保留 10,307 条事件；独立复核确认每一行可 JSON 解析、checksum/sequence 连续，并可用 `ExperimentStore.open(...).replay(runId)` 重建 attempt、manifest、terminal record 与两个 artifact refs。Controller 与 Comparison 均发生安全 fallback，验收结论仍只依赖持久化的运行事实。当前 Windows `workspace-write` sandbox 无法应用 deny-read ACL，因此该次隔离测试显式使用 `danger-full-access`；隔离依赖冻结 archive、临时 workspace 和 scope 审计，不能将此设置推广为默认。

## 执行前准入

- [ ] 历史会话来自 Codex，第一条可执行输入明确。
- [ ] 工作目录为空，或全部输入已冻结到 `TaskCase`。
- [ ] 不需要浏览器登录态、数据库写入、远程服务写操作或用户全局配置修改。
- [ ] 输出只写入 Harness 持有的隔离目录。
- [ ] 不包含发布、删除、付款、权限扩大或其他不可逆动作。
- [ ] 操作者已确认账号：
- [ ] 操作者已确认允许网络：是 / 否
- [ ] 成本上限：
- [ ] 最大墙钟：

## 运行事实

- TaskCase ID：
- Experiment ID：
- Run ID：
- Codex executable：
- Codex version：
- requested model：
- resolved model：
- fidelity：
- termination：
- cleanup：
- report：

## Smoke 步骤

- [ ] 启动
- [ ] 首条输入 admission
- [ ] 首个 turn settlement
- [ ] 一次后续提交（若 Controller 选择 `send`）
- [ ] stop

## 人工判断

- 原始证据核对：
- 候选 artifact 核对：
- trace/report 核对：
- 已知限制：
- 结论：通过 / 阻塞 / 不支持

## 阻塞证据（如适用）

- 阻塞阶段：
- diagnostic code：
- 可复现命令或本地观察：
- 未执行的外部动作：

## 可重复的 protocol smoke

```powershell
npm run build
$env:REPRISE_RUN_CODEX_SMOKE = '1'
node scripts/codex-real-smoke.mjs --data-dir 'C:\absolute\reprise-real-smoke'
```

脚本要求明确的环境变量和绝对数据目录，固定使用 Luna/high 候选以及 Terra/medium Experiment Application。它会保存 `case.json`、`experiment.json`、`events.jsonl`、`RunRecord`、`comparison.json`、`report.html` 和 `codex-smoke-acceptance.json`。本脚本是有界的 protocol smoke，不读取历史会话；首个产品纵切片仍应按准入条件提供冻结的历史 `TaskCase`。

## 本地记录命令

将本模板整理为符合 `CodexSmokeAcceptanceRecordSchema` 的 JSON 后，可用以下命令保存到对应 run：

```text
reprise smoke-record --data-dir <data-dir> --experiment <experimentId> --record <acceptance.json>
```

命令只读取本地 JSON，校验 `taskCaseId`、`experimentId` 和 `runId` 属于已持久化实验，然后以不可变文件写入：
`experiments/<experimentId>/runs/<runId>/codex-smoke-acceptance.json`。
重复写入会失败；该命令不启动 Codex、不读取账号、不访问网络。
