# 决策：Comparison 默认单个自主 Session

状态：accepted

取代默认生产 Comparison 的多阶段、强制 findings 保存和独立 reviewer 调度；旧端口及旧事件恢复契约保持兼容。[整体时间预算](2026-10-11-comparison-total-time-budget.md)中的默认三十分钟继续适用，周期保存与独立审阅不再是默认要求。

## 问题

阶段切换、重复语义保存和多会话转述增加模型往返，工具掩码又限制在写稿后继续查证。结构化 findings 与篇幅处置要求不能认证语义，反而使模型把完成工作流当成交付目标。单 prompt 对照支持简化方向，但模型不同，不能据此断言流程是质量差异的唯一原因。

## 决定

默认工厂选择 AutonomousComparisonAgent，一个自主 Session 接收初始任务和冻结材料导航。调查、验证、编写、预览、修订顺序由模型决定，全程提供既有文件读取/搜索/编辑、shell、受控浏览器渲染、原生图片、裁剪/变换及证据登记能力。沿用 Host 的并行工具声明、互斥写入、脱敏审计、模型输入快照和图片授权，不迁移另一产品的全套运行时。

参考固定版本 [Codex 工具装配](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/tools/spec_plan.rs)，复用的是按能力提供工具、允许自主执行和图片观察的原则。此变更未实现 Codex 全部工具名或 PTY/resumable shell；现有 shell_exec、write/edit 等承担对应能力，不声称完整复制。

工作 HTML fragment 写入 scratch/，submit_report 读取后经既有草稿验证生成 Host shell；可选 detailsPath 提供必要支持。保留文件工具的原始来源只读、真实路径检查、UTF-8 与大小边界、脚本/外链禁用、引用完整性、原生视觉声明证明。write/edit 工具不能覆盖 Host report.html；既有 shell 的命令策略不是操作系统沙箱，不新增其隔离保证。直接改写报告仍会使接受 digest 失效而无法发布。无需 findings/disposition、独立 inspection 或固定 decisionShape 字符额度；简洁及任务相关性由一个 prompt 指导，Host 不制造结论。

请求事件新增显式 autonomousContractVersion=1，与 reviewInspectionContractVersion 互斥。接受工具回执绑定 digest/catalog；之后同 Session 成功预览当前版本，实际 generationInput 含对应预览回执，最后 invocation_completed，才允许发布或离线恢复。任何改稿/目录变化使旧绑定无效，失败、取消、仅工具执行成功或预览摘要不足以发布。该规则是输入及版本完整性检查，不是独立审查或语义正确性证明。

默认三十分钟整体截止，空 override 不移除默认截止；显式较短调用超时或资源限制仍尊重。输出截断可在原 Session 继续，不自动重新调查。未有效提交并预览则失败，不额外开作者或 reviewer 会话伪造成功。

## 备选方案

**继续增加 reviewer 或保存窗口。** 会增加同类往返，故不采用。完全自由执行浏览器或写完整可执行报告将扩大信任边界，故继续受控渲染与安全 fragment。

## 影响

保留旧类供显式端口和历史恢复使用，避免改写旧请求的审核承诺；后续可另行淘汰，无需本次扩大迁移范围。单 Session 取消了独立复审的第二个视角，但减少转述和受限阶段；它不会自动解决模型的视觉或任务理解错误。

## 验证

自动化验证单 prompt/单 Session、工具全程可用、无 findings 回调、失败与取消、文件路径/junction 逃逸、非法编码/大小、安全 HTML、改稿使预览失效，以及真实预览输入的同 Session 版本绑定。保留独立复审的旧契约测试。真实模型报告质量需要另外观察，离线通过和一次真实完成都不代表稳定率。
