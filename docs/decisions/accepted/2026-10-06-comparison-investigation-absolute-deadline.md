# 决策：Comparison 调查使用绝对局部截止时间

状态：accepted

后继：严格三会话路径的编排与时间策略已有[有界审阅收敛](2026-10-06-comparison-bounded-review-convergence.md)作为后继，其他审计、错误优先和发布约束保留。

## 问题

调查阶段只在完整 Provider turn 后检查软限，长生成可能在调查额度到期后继续消耗整体时间，使后续 findings 收尾、写稿和独立审稿失去余量。初始 findings 早存机制不能限制尚未完成的生成，实际收到输入也不证明模型已经完成调查。

## 决定

非 findings-only closure 的 investigate 调用通过已有 Runtime `yieldDeadline` 端口设置绝对局部截止时间。剩余额度取累计调查时间对应的原 `investigationMs` 与整体 `maxElapsedMs` 减去原 90 秒 finishing reserve 的较小值，并钳制为零；默认仍为 120 秒调查、600 秒整体。不新增 Provider 能力，不提高时间、请求或费用预算，不改变模型、effort 或 maxTokens。显式空资源 override 保持无限局部额度；原 source-pass 独立额度及截止机制不变。

Provider 沿用现有 deadline-only abort、等待 session idle、实际 usage 和审计 drain 后返回 `bounded_investigation_timeout`。整体硬限、取消、普通 Provider 错误、审计失败继续优先，不能改判为局部成功。Agent 的资源快照及 phase 事件记录真实中止原因；现有 invocation-start 记录绝对 deadline，模型可见后续说明仍由实际生成快照重建。

局部中止不是 completed-turn 边界、完成调查或成功保证。已实际保存的 findings 和已收到观察保留，不凭未完成生成补造 assessment。若 findings 尚未 ready，沿用原最多两次仅 findings 工具收尾，只从实际收到观察保存结论；未查关系标为 unavailable、条件或未知，保留问题历史。该收尾不继承已经到期的调查局部 deadline，仍受原整体硬限保护。若已有 ready findings，直接进入写稿也必须收到中止说明，并保留决策关键未知，不能把 ready 当语义通过。

将既有 invocation timeout、局部 deadline 和 yield 后硬边界 helper 提取到独立模块以保持源码尺寸门禁，不修改应用、Draft 或 Recovery 接口。

## 备选方案

**缩短模型输出或降低 effort。** 改变评测参数且不建立绝对耗时边界，不能解决长 turn 超过软限的问题。

**将整个调查 timeout 改判 completed。** 会混淆未完成生成和实际调查结果，并掩盖硬限、取消、Provider 或审计失败，因此拒绝。

**给 findings 收尾重新分配调查预算。** 扩大预算且允许重新调查；沿用已有仅 findings 收尾及整体硬限。

## 影响

仅调整调查调用的中止控制与后续事实说明；实际保存材料、独立 source-review、正式审稿和最终发布绑定仍分别验证。局部耗时更稳定不等于结果语义可靠，真实输出关系与报告全文仍须独立验收。未支持新 deadline 的旧 Provider 继续保持普通 timeout 失败，不伪造 typed yield。

## 验证

资源用例核对累计调查时间、不计写稿时间、90 秒整体保留、耗尽钳制和显式无限资源。阶段逆例覆盖局部中止后保留真实 findings、已有 ready findings 不重写、仅 findings 收尾不继承旧 deadline，以及取消、硬限、普通 Provider 错误和旧 Provider timeout 不进入写稿。

Native 流程用例中断真实未完成生成并阻塞实际 usage 审计，证明 drain 完成前不会发起下一次请求；同作者 session 随后仅曝光 findings 工具，后续输入保留实际观察及未知说明，独立 review 仍另建 session。既有 source 局部截止、发布绑定及失败优先用例保持有效。源码先 build，再运行 focused 和完整 `npm run check`；不以这些机械用例代替真实模型语义验收。
