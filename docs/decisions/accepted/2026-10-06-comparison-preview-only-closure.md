# 决策：Comparison 正式核稿之后使用仅预览收尾

状态：accepted

## 问题

真实运行可以完成当前草稿正式检查和匹配预览，随后为证明检查正文实际进入模型又发起一次长生成，最后在该生成完成前超时。实际 generation snapshot 已收到完整材料，不代表该调用成功结束；不能把超时改判成功或强制发表。需要调整收尾顺序，保留真实输入交付认证并避免预览之后仅为结束调用再生成。

## 决定

- 内置应用通过同进程 `hasCurrentReviewInspection` getter 接入 Draft 的正式检查状态。Getter 核对完整实际 onCompleted 交付、正式当前 accepted 对象、review epoch、catalog/findings revision 与 findings readiness；stale、导航收据、截断正文或旧回调不能成立。该 getter 不持久化，不认证语义。
- 当前新路径必须先完成至少一轮真实 full draft audit。初始 inspection checkpoint 即使已取得 current 材料也不能跳过 full audit。该 pass 向模型隐藏 `preview_report`，执行边界也拒绝预览；忽略工具曝光的旧 Provider 无法提前执行预览。完成真实 audit turn 且 Getter 当前成立后才以 `final_inspection_ready` yielded。
- 每次真正进入 full audit 前，Agent 等待同进程 `onDraftAuditStarted` 回调。内置 Draft 撤销正式检查、匹配预览及待交付检查回调，保留此前实际送达的完整正文作为审稿材料；只有本轮 audit 内新检查的完整实际 onCompleted 才能重新认证。Checkpoint 的 current 标记不能让只含被拒 read 或口头承诺的 audit 提前进入 closure，旧 token 与迟到回调也不能重新认证。
- 应用持久化 `comparison.draft_audit_started`，复用已有 review-start payload schema；生产 `reviewInspectionContractVersion` 升为 2。Recovery 对 v2 要求最近 review 开始之后存在 audit-start，且认证检查晚于该 audit-start；v1 历史记录保持原兼容。Schema 接受 1/2，旧读者拒绝新版本，不能把新认证规则错误地解释为旧 checkpoint 认证。
- 如果原 `reviewReason` 在 audit 请求开始时已表明调查额度耗尽或触及收尾保留，实际模型工具列表复用 tracker 的 `beforeTool` 策略隐藏已经会被拒绝的扩展工具，例如 `shell_exec`、`render_artifact`、`register_evidence`、`ls`、`grep`，避免模型继续规划无效检查。不复制独立的扩展工具黑名单；硬保护仍优先。仍保留 `read`，因为注册的修复页可由 `isRepairRead` 放行；普通 read 及所有工具的执行资源守卫保持原规则。未耗额度时仍允许原检查工具；未使用新 audit pass 的旧端口保持原曝光。工具列表在该次请求开始时确定，不宣称 invocation 中途会动态重曝光。额度保护不是语义通过，未检关系须保留为重要未知。
- 然后在同一个独立 review session 开始 preview-only closure。只曝光并只允许执行 `preview_report`。这次真实生成输入须包含实际完整 current inspection，沿用 generation snapshot 和最终发布重建认证；Host 不注入假检查正文。实际预览同 digest 完成后，在工具 turn 的完成边界检查原 `getSubmittedResult`，满足全部绑定才以 `report_ready` yielded，不再发起预览之后的 thinking generation。
- 每次 closure 执行前重查正式当前 getter；期间任何 draft、catalog、findings 或 epoch 变化都使旧检查失效。该 pass 不允许改稿、调查、改 findings 或重复检查；不 ready 则返回正式核稿。Preview-only 调用最多两次；正式核稿沿用最多三次修复和重复状态拒绝，不能无限循环。
- 普通 Provider/tool/预览/审计错误、取消与整体硬限保持原失败语义；不能转成 typed 成功 yield。硬保护与取消仍优先，getter/预览成功不掩盖调用后错误。实际 `getSubmittedResult` 继续验证检查交付、匹配预览及持久化版本，不降低任何发表绑定。
- 未配置 getter 的旧端口保持原核稿/预览行为。当前模型、effort、maxTokens、请求/时间/费用预算不变；这项修复调整流程顺序，不增加原例特定提示或答案。

## 备选方案

**预览 ready 后强行成功或忽略后续 timeout。** 未完成调用可能失败、取消或无法写审计，不能以先前工具状态覆写终态。选择真实 completed-turn 收尾，保留失败优先。

**Host 在新请求中自动插入检查正文。** 会改变模型可见输入和交付认证协议，容易误把注入当实际工具检查。复用同 session 的真实工具结果与现有 generation snapshot。

**只让模型少思考或缩小 maxTokens。** 不解决工具已经 ready 却仍需要额外生成的结构问题，也不能保证调用收敛。保留模型参数，以工具面与完成边界实现流程约束。

## 影响

当前应用新增同进程 getter、audit-start 回调与两个工作 pass，复用既有事件 payload 和实际输入快照。正式核稿、真实检查交付、预览与发表保持独立条件；旧端口未配置新回调时保持兼容。持久化认证版本和 audit-start 事件使 Recovery 能重建相同次序，不放宽预算和发布认证。审稿提示要求每项独立质量或推荐前提对应实际任务关系的 finding；未支持关系仍属条件或未知，这不是机器认证语义。

## 验证

Native 自动化用例核对实际工具曝光、正式检查正文进入 preview closure 请求、至少一轮真实 full audit、预览后零新增请求，以及 Provider 503、取消和审计失败仍不成功。忽略工具曝光的 Provider 用例证明 full audit 不能预览，closure 无改稿/调查副作用，binding 变化回正式核稿并重查后才预览。Application fixtures 使用真实当前检查、后续 generation、匹配预览与发表绑定；未预览/旧 event projection/Provider 失败仍拒绝发表。新收尾提示纳入快照。

Native 实际请求逆例同时证明额度耗尽时扩展检查从工具列表消失、未耗额度时保留、注册修复 read 仍可执行；忽略曝光的 Provider 不能让原执行守卫产生扩展副作用。此变化不增加预算，不把未检证据转成肯定推荐。

Audit-start 逆例以实际 current checkpoint 开始：正式 audit 的第一轮只执行被拒 read，不能 yielded final_inspection_ready 或进入 preview；后续新 inspect 实际交付后才闭合。Draft 与 Recovery 逆例覆盖旧 token/迟到回调和缺失或错误次序的 v2 audit-start，不能复用 checkpoint 发表。

这只解决收尾机制。结构化 supportBoundary、decisionBasis、conclusionScope 与 findingDispositions 的完整声明也不证明模型发现全部反例或正确判断任务可用性；真实输出链与全文语义验收仍独立进行。最终源码须先编译，再执行 focused 和完整 `npm run check`，不得用静态通过或成功 publication 代替产品验收。
