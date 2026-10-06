# 决策：严格调查先保存最小 provisional findings

状态：accepted

## 问题

调查可在首次保存之前读入大量材料，截止时没有可闭合记录，随后 findings-only 在长历史下发生截断与结构修复，消耗独立审阅预算。真实 interaction 校准的第一次 accepted 更新已经 ready 并立即 yield；长耗时发生在接受之前，不能归因为 accepted pending 后重复保存。

## 决定

仅 `reviewFindings`、`enforcePhaseBoundaries` 和 `getSubmittedResult` 同时启用，且提供同进程 `hasSavedFindings` getter 时，初次调查使用简短 investigator 系统提示；没有实际保存记录时先执行 `initial-findings` pass。缺 getter 的既有调用不增加初存请求或持久化推断。只公开并实际允许 update_comparison_findings，阻止强行 read、shell、渲染、注册及报告工具的执行和完成回调。

模型从已提供任务真实提交最小完整记录：未知 finals、空 findings 和带 nextCheck 的 pending 问题合法。Host 不生成观察、引用、问题答案或赢家。只有实际 accepted 回执且 hasSavedFindings 为真才能结束初存并进入普通调查；旧 ready 标记、拒绝、口头承诺和回执而无持久化均不充分。pending 保存只证明可恢复，不能证明 ready 或语义正确。

初存和后续普通调查累计使用原 investigation 时间与请求/工具预算。真实 deadline 后，已保存 pending 继续走既有 Host 闭合，保留原问题身份、历史与未知；没有保存记录仍进入原两次 findings-only 恢复路径。其他失败、取消与整体硬限保持原失败契约，不伪造检查或接受。

之后独立作者、source review、实际 findings closure、新 audit、正式 inspection、后续 generation、matching preview 和发布要求保持。legacy 与独立 review 不使用初存屏障，不修改 Schema 或 on-disk 记录格式；新增 pass 作为现有 phase/event 的可审计过程标签，模型输入仍由现有 generation snapshots 复原。

## 备选方案

**只缩短 investigator 提示。** 不能保证截止前真实持久化，也不能阻止 adapter 强行调查；与执行屏障配套采用，不单独当保证。

**Host 自动生成未知初稿。** 会把模型发现与 Host 合成事实混淆，拒绝。

**延长截止或 accepted 后立即认为 ready。** 前者扩大预算，后者丢失未解问题边界，拒绝。

## 影响

增加真实初存请求会消耗原调查预算；保证持久化结构而非耗时、事实或可用报告。初存失败仍可能走现有恢复，不认证稳定性。模型与 effort/maxTokens/整体预算保持，语义和耗时继续真实独立校准。

## 验证

逆例证明隐藏工具强行调用零执行与零完成回调；accepted pending 能进入调查，旧 saved 无 accepted、accepted 无持久化、取消及持久化失败不能通过初存。阶段集成核对初存消耗 30 后后续调查仍共用原 120 的绝对 deadline，并触发现有 Host 闭合。生产原生 fixture 增加真实最小提交，保持后续完整审阅发布链验证。按项目门禁先 build 再 compiled focused/check，不把 fixture 成功当真实语义或人类阅读通过。
