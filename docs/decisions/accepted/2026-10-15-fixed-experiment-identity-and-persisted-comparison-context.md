# 决策：固定实验身份、版本化预检与已结束运行的重比上下文

状态：accepted

## 问题

旧 ExperimentSpec 保存首轮候选、Agent 与 policy，但后续实际运行允许变化，只比较两个 ID 会静默忽略冲突。TaskCase 原对象可在异步启动期间变化；相同旧 ID/hash 的内容冲突直到连接探测之后才发现。持久化重比只检查 preflight 两个 key，缺失时伪造 available，还用假 Controller、Runtime 和 CandidateRun 绕过执行接口。

## 决定

1. 新 `experiment.json.spec` 使用版本 2，仅固定 experimentId、taskCaseId 和 TaskCase 身份。新冻结 v2 case 绑定完整 contentHash；旧 v1 case 记录旧 hash 与当前保留内容的 canonical hash，仅忽略 provenance.importedAt。不把这种观察升级成 v2 冻结身份或历史真实性认证。
2. Candidate/policy/有效 Harness 配置按每次 run 记录，允许后续轮次选择其他候选、预算和模型。旧无版本或版本 1 的完整 spec 继续读取且不改写；它不能证明首次 spec 的所有设置在后续轮次生效。
3. Admission 在首次异步操作前冻结并校验 TaskCase，保留外部读取的进程内 origin receipt。writer 内先校验固定 metadata 与已发布 case、再无覆盖持久化 case/spec，最后提交 RunAttempt 接纳。确定性冲突没有新 run 事实、activity 或 Agent/probe，并释放 writer。接纳前留下的 case/spec 文件不代表已接纳 run；提交失败不伪造 startup_failed。
4. 删除无生产消费者的延迟 TaskCase 工厂。执行只使用 startup 的冻结快照，不能从调用方可变对象重新获取任务；绑定文件复制后仍由既有发布协议核验实际字节。
5. metadata 与 preflight 在 core schema 中定义，读端明确分派 missing、corrupt、unsupported、legacy、current。显式非正整数版本为损坏，合法未知版本为不支持；损坏不能回退成缺失。新 preflight 包含版本和精确 experiment/run owner，嵌套旧格式必须完整校验，仅 nested missing 才尝试旧根路径。缺失旧 preflight 的可读运行明确 readiness unknown，并写入限制，不伪称 available 或无污染。
6. History 保留单个损坏/未知版本实验，不让其破坏列表；显示 legacy 身份未认证边界。新绑定与保留 case 不匹配时显示具体诊断，不把替换内容的标题附到已认证实验。历史错误 A→B 日志仍按真实 attempt 展示，不能借新 admission 规则抹掉旧错误事实。
7. 报告层使用仅包含 Comparison 依赖与已结束运行事实的 `CompletedRunContext`。持久化重比直接传真实 RunRecord、manifest 与 runtime 事件引用，不构造假的 Runtime、Controller、CandidateRun 或 Session，也不使用双重类型断言。未重建历史 Controller 决定时显式 `not_reconstructed`，followup 保持未知；未记录的 sourceRootKind 不伪造 operator_selected。结果页总耗时从本次重比入口计时，候选原始耗时仍取运行事实，不把旧 run 至今的日历间隔算作重比开销。原始 owner、准备失败审计和不可变报告协议保持生效。
8. 已结束 RunRecord 的 inspection 与 Target 引用只采用 record.trace 的原事实窗口；后续同 run 的有效格式 runtime 文本、usage 或 settlement 不能污染旧运行的回答、指标和证据。没有 record 的运行中查询仍采用当前完整日志，工作区事实继续从 record.artifactRefs 读取。

## 备选方案

**把所有首轮配置永久固定到 Experiment。** 会拒绝正常的多候选、多轮试验，且不能代表当前执行；固定场景身份、按 run 记录实际条件更准确。

**批量升级旧数据或只比较旧 hash。** 前者会为缺失历史证据补认证，后者不能识别旧 hash 未覆盖的任务变化。保留旧文件；新观察只认证当前保留内容，History 明示历史边界。

**继续用完整 ExperimentInput 和空实现适配重比。** 会伪造控制决定和会话，还把无关 Runtime 能力强塞入报告层；使用最小完成运行上下文，让类型检查证明不需要这些能力。

## 影响

新格式不由旧版本 reader 完整理解，回滚须保留新文件并使用支持该版本的程序查看。无自动迁移、无数据删除；旧 metadata 原字节不改写。未知或损坏 preflight 会阻止新重比，已存在报告仍保留。

本机文件不构成抵御同权限恶意进程的认证存储；本批只维护受信程序的 schema、身份和接纳顺序。未新增 Runtime/模型费用，未放宽现有门禁。

## 验证

自动化逆例覆盖同旧 ID/hash 不同任务、v2 body/hash 不一致、异步后原对象突变、外部 frozen bytes origin 保留、零 Agent 与零新 run 事实、writer 可重试、合法候选/policy 变化、旧 importedAt 差异、旧 metadata 字节不升级、损坏及未来版本隔离、preflight 错 owner 与 nested 禁止回退，以及真实记录/manifest 保留、Controller 未重建与 runtime refs 的诚实重比结果。使用 fake Runtime/Pi 与真实本机持久化，不宣称真实服务验收。
