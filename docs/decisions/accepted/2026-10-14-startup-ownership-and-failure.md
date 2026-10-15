# 决策：启动接纳、资源所有权与构造前失败

状态：accepted

## 问题

原候选流程在 writer 之前保存 metadata、准备工作区与启动上下文；workflow 在 Agent 初始化之前发布 activity，但失败时没有完整所有权退出。初始化和工作区准备失败还位于统一清理作用域之外。结果形成以后 Store.close 的错误被吞掉，活动可能留在 running，业务错误也可能被收尾异常覆盖。

## 决定

候选请求的无副作用校验通过后，先取得同一实验 writer 并提交唯一 RunAttempt，再创建活动、初始化 Agent、验证 Runtime 和准备资源。租约失败不向竞争方日志写入自己的事实，也不替换其 control owner。CandidateRun 复用同一 attempt，仍是唯一候选状态机。

Candidate 尚未构造时使用独立版本化启动失败诊断与 run.startup_failed，而非填充伪 RunRecord、manifest、Controller 决策或 Runner 生命周期。文件先无覆盖发布，事件提交才构成可信终态；文件残留不等于提交。schema 与 committed attempt 的 owner 由 Store 校验，错误正文复用现有脱敏策略。持久化失败始终返回调用方，不承诺磁盘坏时仍能生成完整日志。

资源取得后立即登记所属动作。候选工作区是 owned，Recovery baseline 是 borrowed；CandidateRun 接管后的不完整 capture/cleanup 延续原保留策略。活动按对象精确收尾，retire control 先于 writer close；重复动作共享 Promise，退出时移除外部 listener。原始失败与各 cleanup 失败保留，晚于封存结果的清理错误使用补充事件，不改原 record，也不冒充成功。

Recovery 使用自身 operation=initialize 的生命周期 attempt 接纳初始化，不挤入候选状态机。初始化失败持久化后继续拒绝原异常，保留连接探测错误与取消的调用语义。初始化、活动发布、模型准备、release、Store 与 IPC 各自保持明确退出；control 先于 writer 释放，前一项清理失败不阻止执行后面的清理。

writer 锁读写通过 core schema。坏锁或读取错误不能作为可删除的旧锁，nonce/owner 不匹配时保留替换锁；flush 与释放失败同时保留。全局 TaskCase 首次冻结竞争仍由冻结发布契约治理，本批不把实验租约当作全局 case 租约。

## 备选方案

**只在 createRunner 前取 writer。** 不能保护先发生的 metadata、worktree 或 activity 发布，因此不采用。

**给所有失败填一个 finished RunRecord。** 缺少真实 resolvedModel、workspace 或 Controller 时必须伪造字段，而且会混淆未启动与已运行；改用独立启动诊断。

**收尾失败仍返回之前的成功结果。** 会隐藏锁、control 或资源仍未释放的事实。保留已封存结果并追加诊断，但调用返回失败。

## 影响

新增启动失败及清理补充事件和 JSON；旧事件与 RunRecord 原样读取，无历史数据迁移。旧 reader 不保证理解新构造前终态，新的历史查询应以 committed attempt 和对应启动事件解释失败或取消，不能将其作为可重新比较的完成 run。新启动需要唯一 run ID；不可变 attempt 的通用并发幂等不由覆盖文件解决。

direct start 的 activity 在异步接纳成功后才存在，workflow 的 onActivity 回调仍在接纳后发布；跨进程相同实验只允许 writer 成功方继续。没有新增真实模型或 Runtime 调用默认开关，不降低门禁。

## 验证

[启动回归](../../../test/application/startup-lifecycle.test.ts)通过实际 Store、Provider 和 Windows 文件系统覆盖 Runtime、baseline、checkpoint、metadata、prepare、materialize、launch、agents、activity、日志与锁错误；同实验两个真实子进程仅一个进入准备，不同实验各自隔离。不同实验共用已冻结 TaskCase，以免把全局首次冻结竞争混入实验租约验证。

原 Controller resilience、Recovery lifecycle/envelope、control IPC 与 Store 回归继续运行。源码稳定后执行 build、lint、source size、生成区校验和完整 check；fake Runtime 与故障注入不认证真实 Runtime 行为或付费模型能力。
