# 决策：操作所属的有效 Harness 配置与连接检查审计

状态：accepted

## 问题

原记录保存 requested budget，不能证明 Controller 实际无限单次、Recovery 的独立预算和自主 Comparison 的 min 截止。Agent 缓存忽略预算，异步初始化期间调用方对象可变；连接检查先于 Candidate manifest 且没有准确操作 owner。持久化重比在 probe 失败时甚至尚无 Comparison attempt，读端容易继续展示旧成功。

## 决定

1. 默认 Pi factory 用同一冻结预算构造 Agent 和有效 DTO，Agent 缓存包含预算与 locale。连接验证单独缓存，配置/凭据变更重新检查；每个操作仍提交自己的配置绑定，缓存实例不持有可变 owner。

   自定义 Provider 的本机文件密钥或 `env:NAME` 当前解析值参与私有内存中的连接与 Agent 缓存失效判断，引用名不等于凭据身份。预算变化只重建 Agent，密钥轮换还必须重新探测；解析值及缓存键均不得进入持久化 DTO、事件、artifact、报告或诊断。
2. 有效 DTO 是显式白名单，所有新嵌套对象闭合。先提交 artifact，再提交含正文/hash/owner 的 `harness.configuration_bound`，之后才允许本操作 probe。manifest、Recovery initialize 与 Comparison 操作引用本次绑定；无 owner 的旧记录与自定义 Port 保持未记录。
3. 用判别值表示 unlimited 和 finite，不把 Controller 的内部 0 填入旧 AgentBudget schema。Comparison 明确配置单次上限、总截止及逐次 min 规则；只记录实际执行的全局限额，旧阶段限额保留为 requested。
4. Pi caller 在私有内存复制配置（可包含本机凭据）并固定首次解析模型；持久化 DTO 只挑无敏感字段。已知标量 compat override 与 SDK 版本可记录；SDK 私有 URL 默认推导不在应用复制，复杂未记录参数只记字段名，endpoint/headers/认证不记录。该快照不认证完整 wire 请求重建。
5. 每次 outer probe 在调用前记录精确模板、timestamp、reasoning 和配置引用，结果仅分类。内部 SDK retry 不伪造逐次传输。请求审计失败不发请求，传输与完成审计双失败聚合保留；完成审计失败不能进入已验证缓存。
6. 持久化重比取得 writer 后先保留 attempt，初始化/准备失败留下独立 operation failure 及完成事实。原成功报告字节保留，当前失败不借用旧报告；配置/磁盘/审计错误不按阶段猜成 Provider 错误。
7. 已接纳 Candidate 的 candidate/policy 复制冻结，执行使用同一个已提交 attempt 快照。固定 Experiment 身份、preflight 和 legacy 读取分派另批处理，不借本决策宣称这些缺口已消失。

## 备选方案

**只保存 requested budget 或配置 fingerprint。** 无法解释实际无限单次、默认与 min 截止，也不能从 hash 复原输入；保留显式有效值与已知缺口。

**完整复制本机配置或重新实现 SDK 默认推导。** 前者可能保存凭据与路由，后者制造第二套兼容规则；选择白名单、SDK 版本及明确未记录项，generation 实际输入沿用既有快照。

## 影响

新引用、配置和失败协议均为新增可选信息；旧文件不迁移、不补认证。旧 reader 可能忽略这些事件，新 reader 不从旧 raw budget 推断有效值。绑定 artifact 写入后日志失败可留下残留，不能自动认证或补交。SDK 内部重试、凭据和路由不在此记录范围，实际 generation 输入仍遵循既有 Host 快照契约。

不改 Controller、Recovery 或 Comparison 的预算行为，不产生默认真实模型调用。回退保留新 artifact/事件供新版 reader 解释，不删除或重写不可变事实。

## 验证

覆盖预算默认、空 override 与较小整体限额，预算/凭据缓存失效，原配置与注册模型突变，嵌套敏感字段拒绝，artifact/owner 缺失和跨 run 引用，probe 请求审计失败及 transport+audit 双失败，生产 factory 重比 probe/绑定故障与旧报告保全。检查使用 fake Pi 边界与真实本地持久化，不把它称为真实服务验收。
