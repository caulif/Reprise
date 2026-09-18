# Recovery 边界与分层指标

- 日期：2026-08-20
- 状态：accepted

## 决策

1. Recovery 的通用 `staging_shell` 默认不暴露给 Agent；结构化文件、Git 和观察工具是默认工具面。只有显式 Host capability `allowShell: true` 才会加入该工具，且仍只运行在 staging。
2. 评估行保留现有 `durationMs` 作为 case wall-clock；新增可选 `timings` 组件字段。组件未采集时省略字段，不能写 `0` 冒充真实零；只有实际观测到的行参与该组件平均值。
3. 每次已取得 writer 的 Recovery terminal 生命周期在关闭 store 前登记一次过期 artifact 清理。清理失败只记录脱敏诊断，不改变已持久化的 terminal 结果，也不删除报告引用之外的非-Recovery artifact。

## 原因

通用 shell 的 lexical credential deny 不是操作系统 sandbox，默认开放网络也不能作为恢复边界。结构化工具可以提供更小、可审计的能力面；显式 capability 保留本地诊断和兼容测试的迁移出口。历史样本的 `durationMs: 0` 不能被解释成性能数据，因此报告必须区分未观测和真实零。artifact TTL 清理需要挂在 terminal 生命周期上，否则已有 primitive 永远不会被业务路径调用。

## 影响

- Recovery prompt 和工具快照反映默认没有 shell/网络能力；真实 Runtime 默认不产生额外网络副作用。
- 旧评估行仍可读取；旧行组件指标为 unavailable，而非 0。
- 清理按既有 TTL 执行，不立即删除刚生成、仍可能被报告引用的 Recovery artifact。
- 该决策不宣称 Windows 上的 `allowShell` 是强 sandbox；需要真正的网络隔离时必须由 Provider/OS capability 提供，而不是继续扩大 lexical deny。
