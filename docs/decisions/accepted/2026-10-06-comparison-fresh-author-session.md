# 决策：严格 Comparison 使用独立报告作者会话

状态：accepted

## 问题

原例真实运行在 compose 连续两次达到输出上限，没有公开结论、工具动作或接受稿。调查的长会话与通用调查系统提示继续进入作者阶段；工具收窄不能消除已携带的历史上下文。公开尺寸和终态证明未产稿，不能据此读取私有推理或保证换会话后耗时与语义稳定。

## 决定

仅当 `reviewFindings`、`enforcePhaseBoundaries` 和 `getSubmittedResult` 同时启用，首次 compose 释放调查 Session，创建独立 author Session。作者使用简短专用角色提示与现有语言块，不携带调查命令或旧 JSON envelope。实际新工作输入重新提供原任务、`context.promptContent` 和真实保存 findings；它们是待独立审阅的假设，不能当认证结果。Host 双侧指标继续固定在 systemPrompt，来源和模型可见输入沿现有事件与 generation snapshot 复原。

作者从保存观察写短稿，保留改变选择的未知和反证，没有可用依据则使用 insufficient_evidence 与 undetermined。沿现有 compose 工具面、篇幅门禁和真实拒绝反馈修正；实际接受稿后停止。模型、effort、maxTokens、整体预算不变；换会话不重置资源、不补造观察、不认证语义。

独立 source/review 仍再次创建 general Session，不继承作者聊天、结论或初始 findings；收到真实稿件后的 checkpoint、实际 findings closure、新 audit、正式 inspection、后续 generation 与 matching preview 发布链保持。作者会话不能代替 source review，`onReviewStarted` 仅用于真正 review。

取消与整体硬限在 rotation 前及释放后保留原检查，失败不得创建下一付费请求。缺少任一严格条件继续既有调用模式，legacy submitted 模式保持调查/作者共用与独立 review 两会话。

## 备选方案

**只追加短提示或再收窄工具。** 不能清除调查历史与原系统角色，拒绝作为唯一修复。

**丢弃保存观察或让作者重新调查。** 会失去必要事实或重复费用，拒绝。

**增加输出上限、降低审阅或扩大预算。** 未解决输入角色和历史携带问题，且改变验收条件，本次不采用。

## 影响

严格生产流程增加 author Session，但不新增持久化格式、模型输入事件类型或报告权威来源。实际语义和耗时仍由原例及跨任务校准独立验证；fixture 发布成功不等于模型验收或人工可读性验收。

## 验证

真实 Pi adapter 与持久化 generation snapshots 检查调查、author、独立 source/review 三会话：原调查工具结果 sentinel 只在调查输入，原任务、保存假设和 Host 指标实际进入 author；独立 source 初始输入隔离作者假设。生产 submit/discovery 的实际 delta、audit、inspect、后续 generation、matching preview 和真实报告发布由集成用例覆盖。另覆盖 legacy 两会话、语言与短提示、取消和硬限阻止 rotation。主任务统一先 build 后 compiled focused 和 check；本决策不授权新增 paid 调用。
