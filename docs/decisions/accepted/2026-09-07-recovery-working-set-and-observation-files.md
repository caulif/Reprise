# 决策：Recovery 工作集与只读观察文件

状态：accepted
日期：2026-09-07

## 问题

Recovery 把整份 `resolved`（含完整 evidence catalog）序列化进第一轮模型输入，再提供从 `start=0` 翻页的 `read_observation`。厚首包加上思考链和整页冻结 transcript 会使 Pi 在回合过少时无法摘要，Host 抛出 `Context budget: no summarizable history` 并标 `protocol`，隔离候选无法开跑。工作区七件套的根在任务完成后的隔离副本上，看不到冻结会话。

## 决定

进模型的 Recovery JSON 只含工作集：截断后的任务句、有界调查包、解析计数与少量 `evidenceRefs`、假设与候选薄字段、就绪缺口、playbook 版本与 digest。完整 catalog、`verifiedEvidence` 与 playbook 正文不进第一轮 prompt；信封校验仍用 Host 持有的完整白名单。

冻结 transcript、historical events 以及 Comparison 的本 run 事件由 Host 写成候选旁的只读 `observations/`（INDEX + 按 ref 的小文件）。Recovery 通过 `observations` 挂载读取，不把该树写入用户源目录或候选交付。Comparison 把同一棵树写在 attempt 根下，写策略拒绝改它。

Recovery、Controller、Comparison 的工作区工厂名都是七件套：`read`、`ls`、`grep`、`find`、`edit`、`write`、`shell_exec`。不注册 `read_observation`，不留同名空壳。Recovery 另有 Host 工具 `select_recovery_candidate`，不算工作区工厂。

压缩时 Host 先去掉思考链标记并把超页工具结果换成 stub。Pi `prepareCompaction` 无可摘要历史时，Host 收缩工作集并记 `agent.context_compacted`；收缩后仍超窗才失败，文案为工作集仍超窗，不再使用 `no summarizable history`。

调查包路径按相关度排序并降低上限。调查 artifact 的 `sourceRefs` 只保留该 fact 的代表性引用。

本决定取代 [八工具](./2026-08-31-internal-agent-eight-tools.md)、[Recovery 八工具面](./2026-08-31-recovery-pi-aligned-tools.md)、[Controller 七工具](./2026-09-03-controller-seven-workspace-tools.md) 中「Recovery / Comparison 另加 `read_observation`」的条款，以及 [调查包](./2026-08-31-recovery-investigation-packet.md) 中「`read_observation` 仍可分页」的备胎条款。分页观察工具不再是 [有界证据分页](./2026-09-06-ppt-flow-convergence-and-observation-bounds.md) 对 Recovery / Comparison 的入口。

## 备选方案

**保留 `read_observation` 但缩小默认页。** 专用翻页动词仍诱使从首页灌历史。

**只删工具、不物化观察。** 无 Git 的成品目录无法证明任务起点，`recovered` 证据链断开。

**第一轮继续塞全文 catalog / transcript。** 直接复现上下文预算失败。

**把上下文预算标成不可重试 `protocol` 且不收缩工作集。** 把 Host 包过大误判成模型协议损坏。

## 影响

模型必须按路径 JIT 取冻结历史，不能在首包里扫 catalog。观察树占用实验磁盘。TUI 仍可能投影历史事件里的 `read_observation` 名称。无观察文件、只靠当前成品猜测起点，不得标为 `recovered`。

## 验证

`test/architecture.test.ts`：工作区工厂名等于七件套；源码不再注册 `read_observation`。`test/recovery-working-set.test.ts`：厚 catalog 不得出现在模型首包。`test/observation-files.test.ts`：观察文件带 Host ref 且超长截断。压缩测试覆盖思考链剥离、工具 stub 与空 Pi 历史时的工作集收缩。
