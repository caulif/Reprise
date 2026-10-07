# 决策：绑定完整记录的显式 findings 差量更新

状态：accepted

后继：[有界审阅与收敛](2026-10-06-comparison-bounded-review-convergence.md)在严格路径增加单一 delta schema 的专用工具，以及 `addedFindings` / `addedQuestions`；新增对象不再必须重抄完整输入。旧 ID 显式覆盖、完整物化校验、历史身份、原子队列和发布保护继续适用，磁盘完整记录格式不变。以下记录初始决策。

## 问题

独立 source 与实际 draft 已交付后，模型仍需复制全部 findings 和问题历史才可完成实际更新。真实验收出现仅重组结构的长生成、输出截断和反复格式修复，占用审阅与发布预算。已有完整记录可复用，但不能把省略对象解释为独立审查通过。

## 决定

同名 `update_comparison_findings` 保留原完整输入，增加严格 `kind=delta` variant；on-disk 完整 record 不变，不增加阶段。已有 binding 时优先差量，初始记录或新增 finding/question 继续用原完整输入。

Delta 必须绑定实际保存的 revision/digest 及当前 catalogRevision。findingDecisions 和 questionDecisions 各显式覆盖全部现有 ID 恰好一次；每项只能 retain 或 replace。replace 提供完整该对象且 ID 一致，retain 是模型明确评估决定，既不自动验证事实，也不解决 pending。遗漏、重复、额外 ID、删除或改写历史身份均拒绝。criteria、finals、importantLimitations 可显式替换；没有声明的这些字段只保留，不填入语义内容。

Host clone 已保存记录并只应用模型提供的替换，随后先过原完整工具 Schema，再过当前引用、侧别、criterion、支持范围、问题身份及重开理由校验，最后使用原 artifact/event 持久化和精确 accepted 回执。新 catalog 可显式绑定当前 revision 重新校验原引用；不能仅复制旧 catalog binding 或把注册等同新观察。

全部完整更新、差量更新与调查截止闭合共用串行队列。绑定检查在真正执行时进行，第二个排队的旧 delta 不能覆盖已接受的新记录。持久化前后再次检查 delta binding；持久化期间取消或 catalog 变化传播失败，不接受旧材料。该失败可能发生在 artifact/event 写入之后，不产生 accepted 回执或允许继续发布。

状态和 accepted 工具回执公开可直接使用的 binding、findingIds、questionIds；真实 generation 输入、工具参数、工具结果与完整 findings artifact 沿用原事件审计，可以复原差量作用。Host 不制造模型 tool call，不自动代审阅者确认 unchanged。

`review-findings` 提示改为列 ID 的差量动作，保留真实工具更新后的 accepted-ready 标记、两次调用界限、output limit 失败规则、严格 repair read、独立 source 隔离、完整 audit、新正式 inspect、后续 generation 和 preview 发布链。模型、参数、预算与原例内容不变。

## 备选方案

**继续完整替换或仅加提示。** 不能消除已保存结构的复制义务，保留完整输入用于真正新增对象，常规修正用绑定差量。

**允许任意 patch 或自动省略旧 ID。** 容易丢历史问题、隐含省略任务关键发现或覆盖并发新状态，拒绝。

**Host 自行确认 unchanged。** 无真实模型工具执行与独立审阅决定，不能替代现有 accepted 标记。

## 影响

减少的是重复结构输出，不能保证推理耗时或语义正确。retain 仍是模型声明；完整 source 审查和实际稿件审阅保持。差量不能隐式新增或删除 finding/question，确有新增时仍需完整输入。

串行化包括原 direct update，使 tool、Host 闭合及同进程调用不会交错接受记录。旧完整输入、历史 record Schema 与合法幂等 accepted 保持兼容；新的可选工具 variant 是提示/工具协议变更，不迁移历史材料。

## 验证

独立测试覆盖实际全量初始保存、显式 retain 不解决 pending、仅模型替换字段进入新 record、当前 source catalog 重新绑定、旧 revision/digest/catalog、缺记录、遗漏/额外/重复 ID、替换 ID、历史身份及重开理由、支持方法、引用归属与 criterion 拒绝。保留的 legacy 缺支持边界记录也必须过当前完整工具 Schema。

真实异步持久化逆例覆盖取消、persist 失败、持久化期间 catalog 变化和排队旧 binding；不接受旧材料。真实生产入口分别执行幂等 retain 与 replacement delta，检查 actual accepted receipt、revision、独立更新、完整 audit、新 inspect、后续实际 generation 和 preview 发布链。提示快照同步；统一 build、focused/full 检查及后续真实模型验收由主任务执行，机械通过不代语义验收。
