# 决策：Recovery 评估先冻结脱敏 selection manifest

状态：accepted

## 问题

真实 5+5 评估此前把发现、资格检查、分层抽样和执行串在同一个 runner 中。执行前如果 cwd 失效，容易重新发现或重新抽样，导致不同样本之间不可比较，也无法证明复测使用的是同一输入集。

## 决定

在任何 Recovery 执行前生成并持久化 schema-checked 的 selection manifest。manifest 只包含：

- `runId`、固定 `seed`、`selectedAt`；
- 产品标识和 opaque alias；
- evidence layer（`history` 仅代表弱证据，不代表完成或已验证）；
- session content hash；
- 脱敏 source-state 摘要和信号计数。

manifest 不包含 session ID、cwd、source path、任务正文或模型文本。manifest 生成后运行时冻结，执行阶段按 manifest 顺序消费，不重新抽样；私有运行时 binding 只用于把已冻结 alias 连接到本地导入源，不写入 manifest。

满足通用 `isEligibleSession`（至少一个用户输入）的 `history` 记录也可作为**弱证据**候选，只要其 cwd 存在并通过同一隔离检查；不能因缺少 transcript 自动接受或标记 `verified`。为使 transcript 文件和 Claude history locator 使用同一冻结约束，runner 对选中来源先导入并 hash `ImportedSession.raw.text`，执行前再导入并比对该 hash。

如果某个 binding 在执行前失效，只将该 alias 记录为 `source_unavailable`，其余 alias 继续执行。相同 manifest 的重放只能产生相同 alias 集合，不能因为源状态变化而改变抽样结果。

## 影响

- `selection.json` 可以安全用于复核样本集合，不泄露本地路径和会话标识。
- 评估终态新增 `source_unavailable`，与 provider、agent、tool 和 verifier 失败分离。
- source-state 摘要不是任务起点真值；它只能证明选样时的可运行性，不能替代 checkpoint 真值。

## 验证

- `test/recovery-selection.test.ts` 验证 schema、脱敏字段、运行时不可变性、固定 alias 和缺失 binding 不重新抽样。
- `test/recovery-evaluation.test.ts` 验证 `source_unavailable` 是可持久化的独立终态分类。
- `npm run build` 和受影响的 dist 测试通过。
