# 决策：独立观察后先实际保存发现，再核稿

状态：accepted

## 问题

独立 source review 与实际稿件交付完成后，核稿仍可能在较宽工具面中耗尽输出而未修稿或检查。SDK 的模型输入转换会丢弃纯 thinking assistant；同 Session 的有界再调用保留实际工具材料和阶段，不保证续接私有推理。不能将口头计划、旧 ready 状态或未完成生成当作独立评估已保存。

## 决定

- 应用仅在现有 `requireFindings` 生产路径传入同进程 `reviewFindings=true`。先完成独立 source pass 和实际 draft checkpoint，再进入 `review-findings`，最后执行原 full audit、新正式当前检查、后续真实 generation 交付和 preview-only 发布链。旧未 opt-in 端口保持原流程，不增加模型字段或 on-disk 契约。
- 新 pass 仅曝光 `update_comparison_findings` 和有严格 `isRepairRead` 边界的 `read`。忽略曝光的 Provider 也无法执行其他工具或普通 read；资源硬保护与取消先检查。仅基于已经独立收到的观察纠正当前 findings，未查关系保持 unavailable/条件与决定性限制。旧 findings 是修复假设，不能当作证据。
- 每次真实 invocation 开始重置本 pass 的 accepted 标记。只有实际 update 执行返回生产既有、行首精确 `status=accepted` 回执，且当前 findingsReady 为真，才可 `review_findings_ready`。旧 readiness、口头承诺、拒绝或类似但非精确回执不能成立。相同合法 digest 的幂等 accepted 回执也成立，不强制增加 revision；新检查和发布绑定仍独立验证。
- 无实际 accepted-ready 更新时最多两次真实 invocation，然后协议失败。新 pass 不再套用通用 `comparisonOutputContinuation` 的额外一次调用，以免嵌套扩大到四次；即使实际 update 已 accepted-ready，`output_limit` 也不能视为完成；第一次 `output_limit` 必须消耗原第二次机会，在同 Session、同窄工具面再次执行保存步骤，第二次仍未就绪或再次 output limit 就失败。不承诺私有 thinking 续接，不注入它的文本；已执行工具结果和真实保存 findings 保留，不自动重放工具副作用。
- 正常 full audit 保留其既有合法工具与 findings 修复能力，不因前一 closure 已保存就禁止后续纠错。进入 audit 仍撤销 checkpoint 正式认证，要求新的实际完整 inspect；三次 audit 修复界限、preview-only、usage/审计失败、取消及整体硬限保持。局部 accepted-ready 不认证语义，不掩盖 Provider 错误或失败审计。

新 pass 和真实工具输入、回执、generation 输入继续由已有 phase/invocation/tool 事件复原；同进程 marker 不持久化。模型、effort、maxTokens、时间、请求和费用预算不变，也不包含任何原例答案。

## 备选方案

**继续向宽核稿提示追加要求。** 不能证明实际保存动作发生，选择减少这一小步骤的工具选择。

**仅检查旧 findingsReady。** 旧作者状态可以直接通过独立 review，不能证明独立观察参与修复；必须真实执行 accepted update。

**强制增加 findings revision 或保留私有推理文本。** 前者破坏合法幂等更新，后者改变模型可见输入与私有推理边界；均不采用。

## 影响

生产 requireFindings 路径增加一个窄工具步骤，仍共享已有总预算。它能约束保存行为，不保证观察完整、任务关系判断正确或整体调用一定按时完成；真实报告全文语义和新终态布局仍须单独验收。实际工具持久化与同阶段再调用不等于私有 reasoning 续接。

## 验证

Native 逆例覆盖旧 ready 无实际 update、拒绝和伪回执、第一次/重复 length、已执行 update 后 length 的状态重置、忽略完成策略的真实自定义 adapter 在 accepted-ready 后重复 output limit 仍失败、取消、硬限、Provider/usage audit 失败。实际工具列表只含 update 与修复 read；独立执行守卫逆例证明忽略曝光也无越界副作用，full audit 合法工具恢复。

生产应用测试执行真实 Discovery 工具：作者和独立 review 各有一次 accepted 更新，same digest 仅保留一条 findings revision，closure 后新 audit-start、inspect、真实 generation、preview 和发布按序完成。未 opt-in 路径保留旧测试标准；新提示与 checkpoint 提示纳入快照。源码先 build，由统一 focused 和 `npm run check` 验证；机械通过不代替真实模型验收。
