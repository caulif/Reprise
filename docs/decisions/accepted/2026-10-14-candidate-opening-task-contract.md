# 决策：Candidate 首次交接保留任务执行契约

状态：accepted

## 问题

Controller 已收到 task_completion 的冻结目标、交付物与授权，但自然语言开场可能遗漏它们。尤其把“不 commit”等限制省略后，Candidate 会按仓库操作惯例执行；仅要求 Controller 转交不能保证实际输入完整。

## 决定

Host 仅在任务完成模式的 CandidateRun.start 前拼接固定执行信息。逐字未出现在开场的目标与交付物补上；authorization 永远原样附上。工作区取实际 environment.root，外部输入使用 materializeIsolatedStart 返回的已复制映射，sourceRoot 与历史 cwd 仅用于解释原目录到副本的对应关系。交付物保存到工作副本的任务指定相对位置；没有输入映射时不虚构 imported-inputs 目录。无需新 TaskCase 字段或磁盘协议。

默认授权为当前副本内本地修改、按需安装依赖、编译测试和保存草稿；不得影响原用户目录、生产应用或其他任务，不主动 commit，不 push、不创建/修改/评论/合并云端 PR 或 issue、不发布。明确任务授权优先于默认值和冲突的仓库惯例，显式限制仍约束依赖安装。Host 不解析或改写授权、不把依赖安装解释为全面授权。

同一个消息对象进入 CandidateRun.start 与 sent-user-messages；CandidateRun 既有 input.submitted 在 Runtime.start 前保存完整文本与原 message identity。controller.decision 继续记录模型原始结果。新会话重新附上，后续 submit/续跑由 Controller 自主决定原样内容。沿用重复 identity 校验、事件 operation 幂等和 unknown 投递终止规则，不自动重发或从旧原始 decision 重新计算已提交输入。当前没有自动跨进程续跑，重建读取已提交完整消息。

历史模拟（含 execution 缺失的旧场景）完全不拼接，避免扩大历史授权或提前泄漏后续要求。CandidateRun 的 apparently_completed 判断不变。

## 备选方案

**继续只依赖 Controller 提示词。** 无法确定性传递限制。

**每个后续回合重附契约。** 会干预已有自主决策并重复输入。

新增权限解析、系统沙箱或验收 Agent 超出此次范围。固定声明仅约束任务行为，技术上不保证无法越界；本次不新增凭据/网络隔离、命令拦截或额外验收阶段。

## 影响

新增信息只存在于首次消息及其既有完整文本记录，未改变磁盘 schema 或 Runtime 端口。回滚可撤销首次拼接，既有完整 input.submitted 仍能按原事件格式读取，无需数据迁移。

## 验证

离线回归核对真实 Runner 方法收到的文本、重开事件日志及 briefing 一致，覆盖遗漏目标、完整开场、明确授权优先、输入映射、后续原样、新会话、历史兼容与 unknown 投递不重发；默认测试不调用外部模型。

当前事实与生命周期见[执行规范](../../architecture/execution.md)。
