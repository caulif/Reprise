# 决策：Comparison 提示词分层、模板内注释与 data-claim 校验

状态：accepted
日期：2026-09-15

## 问题

Comparison 把同一条规则写在 System Prompt、轮次委托、INDEX 和模板里，措辞不一致。HTML 机械规则出现在模板尚未写入之前。报告壳可见文案硬编码中文。发布检查靠中英词表猜测「已核验 / 已看过」，指令改英文后会漏检。

## 决定

System Prompt 只保留身份、判断纪律、工作区静态事实；与 Recovery 相同，再拼 locale 语言块和可见过程规则。轮次委托只写本轮动作与落盘位置。INDEX 只导航。compose 映射各 Agent 区，并要求 `key-differences` 非空。模板顶部与四个 Agent 区各有一行英文注释；Host 快照忽略 Agent 区正文，判空前剥离 HTML 注释。

声称核验或视觉观察时，Agent 使用 `data-claim="verified"` / `data-claim="visual"`，并分别带可解析的 `data-evidence-ref` 与可用的 `data-media-ref`。Host 按属性检查声明元素、祖先，以及紧随其后的证据/媒体锚点，见 [紧随其后的证据锚点](./2026-09-15-comparison-claim-trailing-citation.md)。现有中英词表按操作者 locale 作兜底。报告壳 `lang`、指标标签、缺失值、cost-note 与诊断文案来自 application 层 `{ en, zh }` 表，缺省 `zh`。

## 备选方案

**继续把 HTML 规则放在 System Prompt。** 模板第三轮才存在，模型要提前记住尚未出现的结构。

**只靠词表做语义校验。** 英文指令下 "verified" / "looked at" 与中文词表不对齐。

**报告壳继续硬编码中文。** 与 TUI locale 脱节，`locale=en` 仍出现中文 Host 文案。

**把报告字符串放进 tui/i18n。** application 不能依赖 tui。

## 影响

Comparison 指令为英文，面向操作者的报告正文与壳文案随 locale。compose 必须写出非空对照区。发布失败码仍是 `evidence_unresolved` 与 `media_unavailable`，触发条件改为属性优先。

## 验证

`test/application/comparison-publication.test.ts`：`data-claim="verified"` 无证据引用则为 `evidence_unresolved`；`data-claim="visual"` 无可用媒体则为 `media_unavailable`；`locale=en` 报告壳无汉字且 `lang="en"`；带区域注释的模板仍通过 Host 快照校验。`test/core/snapshots.test.ts` 锁定 System Prompt 与 en/zh 报告壳。`npm run check` 必须通过。
