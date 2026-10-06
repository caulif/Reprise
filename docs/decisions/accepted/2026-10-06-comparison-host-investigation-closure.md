# 决策：实际调查截止后由 Host 关闭已保存的待查状态

状态：accepted

## 问题

真实验收中，初始调查按 120 秒截止后，模型仅为重新生成已保存完整 findings 的收尾耗时约 188 秒，挤占独立审阅与发布的整体预算。已有 snapshot 保存了问题身份和实际观察；将未查问题继续保持 pending 会阻止 compose，但重新生成完整记录并非必要的证据获取动作。

## 决定

### 尚无初始 snapshot 的边界

真实调查截止时可能从未调用或接受 `update_comparison_findings`。不存在的记录不能由 Host 转换 pending 状态。经过原整体硬限检查和父取消检查后，仅当生产 `hasSavedFindings()` 明确返回 false，保持原真实 `bounded_investigation_timeout` outcome，沿用 submitted 流程已经存在的 findings-only 分支，最多两次真实模型保存调用。Host 不生成 criteria、finals、finding、question 或 observation，不新增阶段、预算或成功认证。

该分支只按可信同进程 getter 判断当前记录缺失，不捕获或匹配错误文本。已有 snapshot 的引用校验、持久化、审计及未 ready 失败继续 fatal；没有提供 getter 的旧调用保持原 Host closure 行为。实际初始保存仍过原 schema、引用、身份与持久化校验，失败、口头承诺或两次后仍 pending 不能 compose；取消和硬限优先。

仅 `requireFindings` 生产路径传入 Host 闭合 callback。初始调查实际返回 `yielded/bounded_investigation_timeout` 且 findings 尚未 ready 时调用；其他完成、输出限额、失败、取消或非 opt-in 端口保持原逻辑。整体硬保护与取消仍优先。

Discovery 在原串行队列内 clone 实际 accepted snapshot，只将 pending 问题改为 unavailable，并用固定 Host 过程文字注明调查截止、问题未核验、不能判断证据不存在、不认证语义。ID、question、decisionImpact、证据引用、nextCheck、重开历史、已 settled 问题、criteria、finals、findings 和限制原样保留。不得生成观察、空占位 snapshot，或从私有 reasoning 补回未保存内容。

复用原 update 的当前 catalog、引用与身份校验、Schema 校验和 artifact/event 持久化。无 accepted、引用失效、持久化或闭合审计失败时明确失败，不转向付费重写，不静默抹掉原稿。新 `comparison.investigation_closed` 事件记录实际截止 reason、session、前后 revision/catalog/digest、受影响问题 IDs 与 not_certified 来源；它不伪造模型工具调用。

compose 的下一实际模型输入携带新保存状态及明确的 Host 过程说明，要求保留原 decisionImpact 的条件与主结论边界。输入仍由原 generation 审计复原。unavailable 问题限制 supported_in_scope 并要求非空 decisionBoundary，取舍见[不可用问题的结论边界](2026-10-06-comparison-unavailable-question-boundary.md)。

独立 source review 仍隔离作者 Session；实际稿件交付、独立 `review-findings` 的真正 accepted 更新、完整 audit、新正式 inspect、后续真实 generation 与 preview 发布链保持必需。Host 更新不能满足独立 reviewer 的工具执行标记。模型、预算、生产超时和 Runtime 不变。

## 备选方案

**继续让模型重生成完整 snapshot。** 已有实际状态可以完成纯过程转换，不应重复花费调查预算后剩余的审阅时间。

**直接设置 ready、删除问题或补空发现。** 破坏身份、证据绑定和完整历史，不采用。

**将未核验关系自动判为正确或证据不存在。** 超出 Host 已知事实，不采用；Host 只证明调查已截止，真实判断留给模型及独立审阅。

## 影响

模型尚未保存的调查结果不会进入新 snapshot。过程 unavailable 可能使结论更保守；它表示本轮没有完成核验，不表示未来不可检查。允许用现有完整记录重新验证当前 catalog，不认证新来源或自然语言事实。

新增事件是持久化契约，记录来源并供审计复原；原 findings record 格式和历史事件不迁移。闭合审计失败可能发生在 findings artifact 已持久化之后，整个 Comparison 必须失败，不能据此 compose 或发布。

冻结评估输入的追加事件白名单同步允许 `comparison.investigation_closed` 与 `comparison.draft_audit_started`；它们属于 Comparison 自身流程，不改变源输入身份和原 committed prefix。仍逐字节核对原文件与前缀，拒绝未知 Comparison 类型及新 Runtime、Controller 观察，不能以新事件为由放宽输入门禁。

## 验证

缺记录回归经真实生产 experiment 工具和 Pi adapter 执行仅 read 的调查、实际局部 deadline、模型初始 accepted save、compose、fresh independent source 与真实 findings 更新、完整 audit、新正式 inspect、后续真实 generation、matching preview 及发布；确认截止前没有更新，Host 没有闭合或制造记录。初始 schema 拒绝、口头承诺、两次 pending、父取消和硬模型请求限制均不得进入 compose/preview。已有记录 invalid refs、persist、audit、not ready 以及未提供 getter 的旧入口仍有 fatal 逆例。

真实生产入口 fixture 从实际接受 pending snapshot 到 Provider 截止、Host artifact/event、下一实际 compose 输入、实际独立更新、新 audit/inspect/generation/preview 与发布全链验证；无 paid findings pass，Host 不增加模型 tool-call 数。

Discovery 逆例覆盖无保存、当前引用失效、真实持久化失败与取消，保持原 accepted；正例逐字段检查观察、限制、问题身份、nextCheck 和 settled 历史。实际 submitted 入口的 callback 失败、未 ready、取消均不能发起下一模型调用。非 deadline、legacy、整体硬限和事件 Schema 反向用例保持。机械检查不替代后续真实模型终态及语义验收。

评估输入门禁正例覆盖两个合法新事件，逆例保留未知 Comparison、Runtime、Controller 和无关 artifact 的真实校验和追加日志，均不能通过冻结输入验证。
