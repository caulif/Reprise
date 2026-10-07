# 决策：Comparison 作者提交一次纯文本决定，由 Host 渲染

状态：accepted

## 问题

作者同时生成 headline、decisionSummary、comparisonHtml，并重复维护 decisionBasis 与 findingDispositions 的 basis 身份。Host 又在 HTML 前渲染 summary、boundary 和检查范围，重复表达增加真实生成时间，并使作者自己的字数估计漏掉 Host 内容。完整正文仍被原主文门禁拒绝；增加生成或字数预算无法解决重复契约。

## 决定

同名提交工具增加 `kind: decision` 输入：保留原 status、category、headline、decisionShape、decisionSummary、decisionBoundary、conclusionScope 和完整 findingDispositions。所有字段必需；禁止 comparisonHtml、detailsHtml、decisionBasis 及未知附加字段。模型仍逐项声明每个 finding 的决定作用与解释，重要未知必须在可见 boundary 表达；Host 不推断正确性、偏好或未查关系。

外部输入分别通过严格 variant 的 `Value.Check`。Host 仅派生 basis dispositions 的 IDs，并设置无文字 `<p></p>`；完整 canonical 再过原 Schema，随后走现有 submit、引用、身份、未知、当前发现、主文 250/600 和折叠 400/1000 字数、正式 inspection、实际 generation 交付及 matching preview 门禁。summary 与 boundary 由原渲染器转义并各显示一次，现有 finding scope 保留。不得截断重要未知、默认选择赢家或降低门禁。

工具根为 object union，保留严格 legacy full 分支，便于必要 HTML details 与经过原验证的真实 source quotes。既有持久化 Schema 和 direct typed submit 兼容；不新增 quote、binding、catalog 或 artifact 协议。真实工具输入仍通过既有事件和模型输入日志复原，接受后的 HTML 与 inspection 保持原 canonical 合同。

strict3 fresh author 的 compose 只曝光 submit 与 update，提示要求纯决定，不让作者重新 read、quote 或制作 HTML；必要调查在先前阶段完成。strict2 兼容作者保留原工具曝光。后续独立 review 仍允许必要修正工具与 legacy full 表达，实际检查、完整审计与发表链不因作者简化而跳过。

## 备选方案

**只要求作者少写 HTML。** 仍需同时维护 summary、HTML 和 basis IDs，无法从契约消除重复，因此不作为唯一方案。

**删掉完整 HTML 分支。** 会破坏既有调用和必要的折叠细节、真实摘引表达，因此保留严格 legacy full 分支。

**Host 自动补写结论或扩大字数。** 会把未知或模型判断变成 Host 生成的事实，并放宽用户需要的简短报告边界，因此拒绝；Host 仅机械派生冗余 IDs。

## 影响

纯决定路径省去重复 HTML 和 basis IDs；它不会自动发现反例，也不保证模型写出正确判断。必要额外展示可继续使用 full 分支；两个分支均计算全部实际 Host 渲染内容，原字数预算保持。nondecisive explanations 原样留在输入声明，不被 Host 冒充事实或补写到结论。

## 验证

正例验证真实工具、转义、单次可见 summary/boundary、canonical basis 派生及 legacy full 兼容。逆例覆盖 variant 多余字段、缺必需字段、重复或遗漏 finding IDs、重要边界缺失、unsupported scope 和两类超长主文，不能改变已接受稿。真实 production Pi fixture 验证模型纯决定输入到 findings、独立 source、更新、audit、inspection、后续 generation 与 preview 发表链；自动化通过不替代真实模型语义和阅读验收。
