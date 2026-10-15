# 决策：结果展示消费最小事实，不伪造运行对象

状态：accepted

## 问题

历史投影只保存部分结果事实，旧 TUI 为复用实时结果文案而构造不存在的 Session、报告路径、证据引用及 Agent failure。缺失 Comparison 详情会被补成 completed，未知状态还需强转为不包含 unknown 的业务 union。展示对象因此冒充了真实执行结果。

## 决定

实时结果与历史投影先映射为最小 ResultPresentationInput，再由同一纯函数生成文案与色调。已知任务、终态、清理和 Comparison 枚举引用 core/application 类型；展示输入合法表达 unknown、interrupted、record_unread 和 pending，不反写 CandidateRun 或事件。

Comparison 展示事实只包含 invocation status、实际保存的结果 detail 和可选失败诊断 token。History 不生成 sessionId、reportPath、evidenceRefs、调用次数或默认 agent_failure。completed 但缺少或不认识 detail 时，比较结果保持未确认；已保存的失败 token 原样保留。报告路径与归属继续使用应用层查询结果，缺字段不能由展示层补出。

页面继续消费既有 presentation 文案、色调和动作；键盘、滚动、报告打开与局部状态拥有者不变。本批不引入另一套运行状态机，也不拆分 IntakeTui 的交互状态。

## 备选方案

**扩展 ExperimentResult 以容纳历史缺失字段。** 会把展示缺口混入真实执行结果协议，削弱运行结果的完整性约束。

**继续伪造最小 Session 和报告。** 虽能通过类型检查，却会把不存在的事实带入后续调用方，且 missing detail 仍可能被当成成功。

## 影响

调整 [TUI 展示输入](../../../src/tui/display-state.ts)及历史页消费；应用层在既有 comparisonDetail 字段保留实际 completed 值，不能把已知完成与缺失详情都省略为 undefined。不修改 on-disk、模型输入或查询字段布局。未知状态沿用现有未确认文案；旧 completed 缺 detail 不再显示比较成功。当前用户行为见[使用说明](../../usage.md#tui-路径)。

## 验证

覆盖合法 unknown/pending 展示输入、legacy completed 缺失和未知 detail、未知 task/termination/cleanup、已知及未来失败 token、启动失败与未确认报告共存；实际 fake Runtime 运行结果与历史投影在中英文下生成同一组事实文案。既有 History 点击、报告打开、TUI 帧及输入回归继续约束页面行为；不调用真实模型或 Runtime。
