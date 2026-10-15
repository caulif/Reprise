# 决策：workflow 使用组合根注入的 Pack 与候选 Runtime

状态：accepted

## 问题

workflow 已接受独立 ProductLookup，但 preflight 再查询全局注册表，导致未激活到全局的合法 Pack 被拒绝。显式 Runtime 注入只用于 preflight/start，目录和候选校验却仍使用 Pack 内置 Runtime，用户选择与实际执行可能不一致。

## 决定

workflow 的 Pack 解析始终使用注入 Pack/lookup，preflight 的低层入口只校验已选择的 Runtime，不重复作注册表查找。恢复与历史提取继续明确传递所选来源 Pack；组合根及查询命令仍负责组装自己的 lookup。

显式 Runtime 是 workflow 候选端口的统一覆盖，目录、可用性、校验、preflight 与 start 都使用它。先检查所选 Pack 的 runtime 能力，覆盖不能使仅支持导入的 Pack 变成可执行产品。Runtime 的 id 是实现标识，不要求等于产品名；validateCandidate 的已解析 productId 必须匹配候选，未知模型继续拒绝。未验证的 preflight 只选取匹配产品的 availability，不把其他产品的执行信息配给当前候选。

来源 Pack 可与候选 Pack 不同；显式覆盖不改变来源历史解释器、Recovery playbook 或用户可见投影。没有新 on-disk 格式，也无需数据迁移。

候选 Pack 的 projection 随所选 Pack 贯穿 steering、完成检查与 Comparison 输入构造；持久化重比按运行记录中的候选 productId 从当前 workflow lookup 重新选择。不能在这些路径退回全局注册表，否则未全局激活的 Pack 会在首个 settled turn 后失败，同名 lookup 也会互相串用投影。底层检查入口保留 productId 字符串兼容，但 workflow 必须显式传递 Pack。

## 备选方案

**将测试或插件 Pack 全局激活。** 继续耦合相互独立的 workflow，不能保证实例隔离。
**删除 Runtime 注入。** 扩大测试及组合根改造，且不会自行消除 preflight 的全局查找。
**要求 runtime.id 等于 productId。** 现有契约未作此约束，adapter 的实现标识也不能证明实际解析产品。

## 影响

[workflow](../../../src/application/experiment-workflow.ts) 统一候选 Runtime 选择，[preflight](../../../src/application/experiment-preflight.ts) 移除全局查找并检查已解析产品。现有仅注入 Runtime 的组合继续工作，但其目录与验证现在也遵循该覆盖；使用方应通过所选 Pack/lookup 明确产品能力。数据格式、插件加载与全局注册 API 保持当前契约。

## 验证

[workflow 回归](../../../test/application/workflow-pack-lookup.test.ts)覆盖独立 Pack preflight、同名产品的两个 lookup 隔离、显式 Runtime 一致性、未知产品、能力不足、解析产品错配和未知模型。现有第三方 Pack registry、跨产品历史 Comparison 及内置 preflight 测试继续运行；默认验证不启动真实 Runtime 或付费模型。

完整假 Runtime 回归还覆盖未全局激活 Pack 和与内置产品同名的局部 Pack：验证 steering briefing、持久化用户视图、完成检查和持久化重比均使用各自实例的 projection。

当前规则见[Pack 边界](../../architecture/overview.md#pack-边界)。
