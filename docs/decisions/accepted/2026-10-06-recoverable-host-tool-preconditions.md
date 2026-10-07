# 决策：无副作用的 Host 写策略拒绝不锁存为致命执行失败

状态：accepted

## 问题

Comparison 的 source 审阅中，Recovery workspace broker 正确拒绝只读 mount 写入，Pi 把错误交给模型，模型也可以修正操作。然而旧拒绝仍被 invocation failure latch 永久记录；之后正常的 completed-turn source soft yield 经 `assertCanYield` 时重抛旧错误。普通完成与正常阶段让出的处理不一致。直接忽略全部工具错误又会隐藏审计、持久化或实际副作用失败。

## 决定

增加同进程 `ToolPreconditionRejected` 类型，理由只允许 `read_only_mount` 与 `host_write_policy`。只有 Recovery broker 在效果前已经确定拒绝的写路径、写 containment root 和只读 shell guard 使用该类型。它们的位置保持在 mkdir、写 journal、文件修改、shell home 创建和 spawn 之前。原 mount、路径、symlink、shell 拒绝规则和允许策略不变，不新增写权限。

Agent instrument 只在原始 `tool.execute` 抛出该实例时保留可恢复分类。先正常记录 `agent.tool_failed`，再向 Pi 抛出保持该类型的 `AgentToolFailure`；模型看到原固定 Host 拒绝及修正建议，native after-hook 仍记录 `isError=true`。不按 message、error.name 或任意 cause 链识别。原始 execute 之后的审计、图片交付、result 处理、onCompleted 与 native hook 失败即使也是这个类型，仍按致命路径处理。

Pi 仅在 tool execute 入口不把这个明确拒绝写入 fatal latch；依旧将它抛给 SDK，不自动执行修正或返回假成功。其它 execute 错误、审计/持久化/交付失败、before/after hook、usage、模型请求、取消和硬资源门禁维持原路径。`assertCanYield` 不放宽，正常 completed 的历史语义不改变。

这个错误是可信 Host 内部分类，不是 Provider 输出或持久化协议；不新增外部 JSON 字段或 schema，不改变事件名称和 on-disk 格式。其它使用同 broker 的 Agent 仍收到同一拒绝与错误审计。

## 备选方案

**忽略所有 AgentToolFailure 或删除 yield failure check。** 会把实际执行、审计、持久化与交付失败解释为正常让出，拒绝。

**按 write_denied 文本、错误名称或递归 cause 识别。** 容易把未知执行错误或发生副作用后的失败误判为无副作用拒绝，拒绝。

**把拒绝改为普通成功工具结果。** 会丢失 native isError 与明确失败语义，并使正常成功审计误导后续判断，拒绝。

## 影响

模型现在可以依据同一次拒绝的具体建议继续读取或在 work copy 修正写入，并到达正常 source soft boundary。可恢复不证明模型已经修正，也不认证 findings；独立 source、实际 findings 更新、full draft audit、新正式 inspection、后续 generation 和 preview 发布仍必须真实执行。

新增类型只能用于效果前的可信拒绝；实际操作失败及回调失败不得抛此类作为恢复信号。shell guard 的既有防护能力不扩展、不削弱，本决策不把静态命令匹配描述为完整 shell sandbox。

## 验证

独立 broker 用例检查实际 readonly mount 的 edit/write/shell 拒绝，零 spawn、零 journal、目录不变、源文件字节不变；Host 写策略拒绝不得创建目录。native Host 用例检查实际拒绝仍有 `agent.tool_failed` 和 native `isError=true`，下一 generation 收到可操作拒绝建议，模型真实修正写入后可正常 soft yield。

逆例覆盖拒绝之后实际 execute、journal persist、onCompleted 交付、失败审计、native before/after hook、取消和硬边界错误；伪造相同 message/name 的普通错误不能豁免，typed callback/hook 错误也不能豁免。

生产 Comparison fixture 经真实 Pi adapter 和 experiment 工具执行拒绝、修正、source soft yield、checkpoint、accepted delta 更新、完整 audit、新正式 inspection、后续 model request 和 preview 发布；另有该拒绝之后真实取消与 Comparison 硬资源门禁阻止 preview 的逆例。编译后测试与全量检查由主任务统一执行，真实模型验收独立记录，fixture 不替代真实模型语义验收。
