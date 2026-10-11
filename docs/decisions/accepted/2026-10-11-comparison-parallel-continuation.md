# 决策：Comparison 独立工具并行、来源活动预算与冻结图片变换

状态：accepted

默认预算部分由[整体时间预算](2026-10-11-comparison-total-time-budget.md)取代；本文局部截止与配额政策仍适用于显式旧资源配置。

部分取代 [Agent foundation](2026-09-09-agent-foundation-host.md) 的全局固定串行政策；不改变同 Session 模型请求互斥、恢复与发布认证。

## 问题

真实 Comparison 的主要耗时在模型往返，但全局串行也阻止同批独立读取和双侧渲染重叠。来源墙钟窗口包含语义保存等待，局部到期可能关闭仍有全局余额的检查。模型的视觉漏判属于能力表现，不由项目增加题目专用语义规则兜底。

## 决定

- 复用 Pi SDK 的 parallel 批次模式。工具新增可选 executionMode，省略时明确 sequential；只有 Comparison 的 read、ls、grep、view_image、render_artifact 标记 parallel。任一 sequential 工具使 SDK 整批顺序执行。Controller/Recovery 默认不变，不并发模型 invocation。
- canonical tool_called 在异步审计前同步预留总工具额度，超额调用不进入工具。执行入口再次检查取消，SDK prepare 后的取消不能启动已准备动作。工具审计记录 requestIndex、执行模式与时间；实际重叠由执行区间和 barrier 测试证明，不按配置推断速度。
- 每次渲染使用独立 UUID scratch 目录，FIFO 容量为 2；排队可取消，取消不启动浏览器。同页时间采样仍有序。媒体拷贝路径同样隔离，失败不能删除另一次注册依赖的文件；catalog 原队列保持原子登记，preview 仍有序。
- 调查和复审各累计实际保存耗时，不把两次保存间的来源工作计入保存额度，累计上限不续期。保存等待仍耗费整体硬预算，但暂停来源活动截止；恢复来源时也受全局收尾保留限制。来源请求/工具计数排除机械保存。局部截止后在原 Session 提供最多两次、每次最多按总额比例缩放的 60 秒续查机会，模型选择继续或结束，宿主不判题。全局时间、费用、请求/工具额度不重置。显式短来源时间不扩大；资源不足、取消或完整性失败不续查。
- comparison.sources_continued 记录授予/拒绝、旧新截止、余额和次数，持久化前按 schema 验证。保存截止使用独立 save_timeout 原因；存在实际旧 snapshot 时可继续来源，停用该阶段后续周期保存，不认证未保存观察。最终闭合与独立复审仍必须通过。
- agent.model_stream_completed 记录首个 SDK 流事件、首个 text_delta、消费结束及事件数；不收集 token 正文。首流事件不是 HTTP TTFT，不代表首可见文本；未收到相应事件记 null。工具时间之和不是工具墙钟并集，也不能直接从总时长相减当模型耗时。
- transform_image 对已授权、已注册、校验 hash 的冻结 PNG 裁剪后缩放，复用现有 CDP 浏览器 canvas 解码与编码，不新加图像依赖。先限输入/解码像素，输出有尺寸和字节上限；不加载来源页面，不重采动画时刻。image_transform 派生记录保留父 hash、原尺寸、像素裁剪框、输出尺寸和顺序，经现有 catalog、图片交付与模型输入链复原。变换不认证元素语义或关系。
- Codex 参考固定为 [cc7ba336 的 view_image](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/tools/handlers/view_image.rs)：借鉴原生图片工具与能力边界，不声称复制现成 crop API。Reprise 不向未声明支持的网关发送 original detail；发送的是预算内原始 PNG，服务如何缩放仍未知。
- source-save 可选 evidence context 投影保留所有 user 材料、所有工具结果及原 toolCall 配对，仅省略 assistant 叙述。实际投影进入 generation 快照；本地完整 transcript 不被改写，后续调查恢复原上下文。它是保守减负，不是完整的每批独立小上下文。

## 备选方案

**所有工具继续串行。** 实现简单，但同批独立图片读取与双侧渲染无法重叠；选取按工具声明并保留写操作串行。

**直接移除来源截止。** 会挤占作者与发布阶段预算；采用有次数上限并保留收尾余量的续查。

## 影响

inspect/preview 的宿主直接编排本批不实现：离线恢复仍要求实际 inspect 完成回执、绑定原文进入后续 generation，直接设置已读标记或伪造 assistant toolCall 都无效。后续须设计版本化宿主材料输入和恢复验证，并把真实预览图交付审核者。本批不声称减少这几次机械模型往返。

不认证模型判断正确，不强制几何检查，不内置脚踏等样例答案。并行、活动预算、图片变换和 context 投影可独立回退；新 reader 保留历史读取路径，旧 reader 不保证识别新增派生类型。

## 验证

真实 Pi barrier 验证独立工具重叠、混合批有序及 prepare 后取消；渲染桩验证独立目录、容量峰值 2、FIFO 和队列取消。模拟时钟覆盖来源保存暂停、续查两次上限、显式短资源、全局收尾保留和计数不重置。持久化与图片链回归覆盖派生元数据与实际原生交付，真实浏览器测试单独 opt-in，完整 check 不与浏览器任务并行。
