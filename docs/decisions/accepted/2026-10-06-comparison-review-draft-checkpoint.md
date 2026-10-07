# 决策：Comparison 独立审查先取得真实草稿正文

状态：accepted

## 问题

真实评估中，独立 source pass 已读到反证，但 draft audit 首次请求仍可能长时间推演而未调用草稿检查；最后即使正文实际送入生成请求，也可能因剩余时间不足未修正或预览。模型口头说已检查不能证明取得实际正文，来源调查完成、局部中止或 Host 接受草稿都不认证语义。

## 决定

- 内置生产路径传同进程 `hasReviewDraftMaterial` getter。它只在 `inspect_comparison_draft` 真实成功完成正文交付后成立，并绑定 accepted 对象、review epoch、读取时 catalog 与 findings revision。模型自述、unavailable/截断响应、失败的审计提交及过期回调不能解锁。正文可来自 current 或 stale accepted 草稿；stale 仅供修复，不满足正式最终检查或发表。
- 工具结果在反馈与脱敏链中可能经对象 spread 克隆。交付身份使用私有 enumerable Symbol token 与 WeakMap 作为同进程身份桥，原 token 随合法 spread 保留；不按正文内容猜测身份，旧 epoch 的同文延迟完成不能认证新交付。精选脱敏及 text-only clone 显式保留此内部 token，不扩展其它未知字段。完成身份还须匹配实际模型可见的完整 headline/comparison/details 脱敏值；contentBlocks 存在时只核对实际 text blocks，不能用未进入模型的 content 备用字段认证，合法 token 也不能认证省略、stub 或截断正文。token 不写入 JSON、模型正文、details、事件或 Recovery，不新增持久化协议；它只证明真实 onCompleted 的身份，不证明模型已理解正文或语义正确。
- source pass 之后，配置 getter 的 Comparison 先执行 inspection checkpoint。仅向模型曝光 `inspect_comparison_draft`，执行边界也只允许该工具；忽略工具曝光字段的自定义 Provider 不能执行读源、改 findings、提交、写入或预览。原整体硬保护与取消优先。
- checkpoint 在真实 getter ready 的 completed-turn 边界 yielded，最多两次实际调用；口头承诺不能完成 checkpoint。缺少检查工具、两次调用仍无真实正文交付则明确失败；普通 timeout、工具/Provider/审计错误、取消和整体硬限不转换成成功。未传 getter 的旧端口保持原流程。
- source、inspection checkpoint 与完整 draft audit 使用同一个独立 review session；不新建审查会话、不以 Host 编造工具结果或注入模型正文。取得实际材料后解锁原工具面，立即比较实际 claims 与保留的独立反证，不重复检查仅为再取得未变正文。
- stale 材料必须按现有规则修复；任何 accepted revision 或 binding 变化仍需新的正式当前检查和 preview。真实检查工具结果进入后续实际 generation snapshot 的发表认证保持不变。初始正文交付、最终检查、预览和模型语义判断分别成立，机械 ready 不认证判断正确。
- 接受身份以类型化的完整提交、结果、HTML digest 和 catalog/findings revision 比较，而不以 HTML 代理审查声明。status 或 conclusionScope 等字段改变了被审阅的主张，即使 HTML 不变也更新结果、递增 bindingRevision、失效旧 inspection/preview，并重新追加既有接受绑定事件；离线认证继续用最新事件顺序与工具回执排除旧版本。完整身份相同才保持幂等，不增加 on-disk 字段。
- 不调整 lane、effort、maxTokens、请求/时间/费用预算，也不加入具体实验答案。此检查点只改善取得材料的收敛，仍不能保证模型短时间调用工具、修正所有错误或成功发表。

## 备选方案

**Host 自动注入草稿正文。** 需要新增可见输入协议、审计及认证语义，还容易把 Host 注入误当作实际工具检查。复用现有检查工具和真实完成回调，保留原输入可复原与检查认证路径。

**仅强化提示。** 不能保证首次调用检查，也不能阻止旧 Provider 提前改稿或预览。选用已有单次调用工具曝光能力和执行守卫，不增加 Runtime 能力或额外事实库。

## 影响

新增可选 getter 与同进程交付身份桥，复用现有 Freeform 工具曝光、completed-turn yield、正文交付与后续 generation snapshot。旧 getter 缺省兼容；不改变 on-disk Schema 或 Recovery 认证。新增 checkpoint 提示、工具拒绝和真实 ready yield 沿用原事件审计，可从实际模型输入复原。Getter 不能替代最终版本绑定、语义审核或真实模型验收。

## 验证

自动化逆例证明口头承诺、unavailable 和缺工具不能解锁；旧 Provider 忽略曝光时扩展工具零副作用；取消、整体硬限和真实检查错误不进入完整审查。实际 Pi 输入测试证明 checkpoint 仅曝光检查工具、首轮口头承诺仍需第二次真实工具交付、交付后恢复默认工具面并保留同 session 正文，最终仍需检查/预览后的实际请求。application 测试覆盖 current/stale 正文的真实 onCompleted、审计失败及 binding/epoch 变化；stale 不能发表。checkpoint 提示纳入快照。编译 focused 与 `npm run check` 必须验证最终源码；静态与 fixture 通过不代替真实模型语义验收。
