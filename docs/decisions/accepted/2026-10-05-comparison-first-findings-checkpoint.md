# 决策：Comparison 调查首次保存真实 findings 检查点

状态：accepted

## 问题

调查提示原来仅要求在结束前保存 findings。真实评估多次在调查结束时仍未保存，随后收束出现长时间 thinking 和输出上限，挤占独立审查时间。模型口头承诺不构成真实保存；缺少初始状态也不能靠 Host 代填答案修复。

## 决定

- 新草稿生产路径传入同进程可选 `hasSavedFindings` getter，直接读取 `ComparisonDiscovery.snapshot()` 是否存在，不解析模型正文或 `getFindingsState` 文本，不添加持久化格式或额外事实库。未传 getter 的旧自定义端口保持原行为。
- 仅自然 investigate 在首次真实 snapshot 被接受前，执行边界拒绝 `shell_exec`、`render_artifact`、`register_evidence`，返回 `findings_checkpoint_required`；原工具零副作用。read、ls 等导航与 `update_comparison_findings` 仍按原预算可用。首先执行整体硬保护与取消检查；软限、closure、source review 原规则优先，不把硬失败或取消转换成可修复的检查点回复。
- 模型从实际已读任务保存最小完整 snapshot：至少一个任务标准，两侧 final 各一条，尚未定位的 final 可 unavailable，尚无实际验证可 `findings: []`，未完成的重要问题为 pending 并给 nextCheck。不要求为未知另一侧伪造观察。标准及来源说明仍由模型表达，Schema 接受不认证它真实读过来源或语义正确。
- 只要原 discovery 真正接受，解除首次检查点限制。非法更新、口头承诺或保存失败不能解除。后续重要结果与 catalog 变化由调查提示要求及时提交完整 replacement，并保留全部历史问题；不在每次渲染后强制再次保存，不重复追加长工具反馈或扩大工具结果包络。
- `readyToCompose` 保持原规则：接受 snapshot 绑定当前 catalog，所有问题已 resolved/unavailable；pending 初始 snapshot 不能进入 compose。问题身份、完整替换、重开理由、双侧观察及原独立 reviewer 隔离均不放宽。独立 source pass 不接受作者发现更新，也不在输入中注入作者 findings；draft 审查另按原规则修复。
- 不增加 orientation 阶段、模型请求次数、时间或费用预算，不修改 lane/effort/maxTokens，不加入特定实验答案或自动重试输出截断。已有 bounded closure 仍用于真实未完成问题，首次检查点不能保证消除 thinking 截断或保证报告语义质量。

## 备选方案

**独立 orientation 或每次检查后的强制保存。** 额外阶段会增加请求往返；每次渲染都要求保存会重复消耗预算。选择自然调查的首次执行检查点，之后提示及时更新；无法保证仅靠连续 read 的模型一定及时保存。

**Host 预填空 snapshot。** 这会用机械占位替代模型已读任务与真实问题判断。只允许模型按现有 Schema 提交，接受记录仍由原 discovery 验证与持久化。

## 影响

新增可选 getter 属于同进程调用契约，不改变 on-disk Schema 或 Runtime 端口。生产路径启用首次执行门；旧缺省 getter 兼容。模型可见新增拒绝反馈和调查提示均沿用现有工具结果与请求事件审计。输入可复原，不依赖未记录的额外提示；本门只认证真实接受状态，不认证来源阅读或发现语义。

## 验证

自动化逆例覆盖三种检查工具在未保存时零副作用、非法更新后仍拒绝、未知 finals/空 findings/pending 合法接受、接受后正常执行且原正文与 text-lane 图片过滤保持、pending 必须收束才能 compose、完整问题历史不能丢弃、source pass 无作者 snapshot 输入且不能更新、旧 getter 缺省兼容、整体硬保护/取消优先、真实工具错误继续失败。工具错误公开返回 Host 包装失败，其原工具名与错误仍须出现在实际 `agent.tool_failed` 审计，不要求公开接口复制原错误。调查提示单独纳入提交 snapshot。编译后跑 Comparison phase-yield、discovery、snapshot 测试及 `npm run check`；静态检查和自动化通过不替代真实模型与独立语义验收。
