# 决策：共享 Comparison 不变量在当前生产构造入口验证

状态：accepted

## 问题

旧 Comparison executor 的测试混合了阶段策略与仍适用的 Host 发布不变量。默认实现已切换为自主 Session，仅保留旧测试不能证明默认构造入口的发布、模型预览输入、失败分类和资源收尾仍满足这些边界。首次迁移发现自主实现未保留旧 executor 的 Provider 失败代码及 compare 返回前关闭 Session 的行为；真实 Pi 调用产生的 stream 完成事件也被评测输入 suffix 校验误拒绝。

## 决定

共享发布回归使用 createHarnessAgents、PiModelCaller 和离线 PiModels 流，经真实 write、submit_report、preview_report 及后续 generation，不返回手造 completed result 代替发布认证。模型文本为空、预览后修订、图像投递、Provider 失败和只读拒绝后的实际 scratch 修正均在当前入口验证。

自主 compare 在所有出口记录资源完成并释放该 attempt 的 Session；外层 release 保持幂等。资源审计和 Session 关闭独立尝试，若收尾失败，AggregateError 同时保留原始失败或取消原因及全部收尾错误。已由共享 Host 归类为 authentication、rate_limited、transient_network、transient_upstream 的失败映射为 provider_failure；其他类型不重分类。

评测冻结前缀、输入字节和 run 绑定不变；允许 role=comparison 的 agent.model_stream_completed 作为合法 suffix，Controller 的同名事件仍拒绝。本批迁移是退役准备，旧 executor、历史 schema/reader 和尚未迁移的测试继续保留。

## 备选方案

**删除所有旧 executor 测试**：会丢失仍适用的不变量，也掩盖默认路径的实际缺口。按断言迁移，阶段策略另批退役。

**只测试注入的 completed Port**：绕过了工具、预览和 generation 绑定，无法证明实际生产发布链。

## 影响

不新增真实模型调用或外部费用。fake 模型流与 PNG renderer 证明机制和输入投递，不代表真实模型质量或浏览器视觉验收。没有 on-disk 格式迁移；旧历史认证继续读取。当前失败进程会关闭模型 Session，Provider 失败诊断代码恢复一致。

## 验证

迁移回归覆盖实际只读拒绝、scratch 命令 exitCode 与文件字节、当前预览图像进入后续 generation、无预览或旧预览拒绝发布、预览后 Provider 失败、空最终文本及重新预览后的发布。原 TCP listener 退出回归迁到自主实现；收尾负例同时注入主失败、audit 失败和 close 失败并检查外层重复 release。冻结输入负例拒绝 Controller 同名 stream 事件、修改过的 committed 前缀与源文件。

现行规则见[证据与对照](../../architecture/evidence-and-comparison.md#comparison-attempt)。
