# 决策：保存每次 generation 实际输入上下文快照

状态：accepted

## 问题

旧模型输入重建按消息与工具审计投影。工具参数是安全类型摘要，SDK 原生 schema 校验拒绝的调用及错误不一定进入该审计；Provider transform/prune 后的真实消息批次也可能不同。投影的 `contentComplete=true` 只说明记录的正文与图片附件可读取，不能证明实际 generation 收到完整参数、原生错误或 inspection。将该标记用于正式发布认证可能接受并未出现在真实输入中的内容。

## 决定

- Pi 在 SDK 完成 transform/prune、转换为 Provider Context 后，每次 generation 的 `onModelRequest` 传递实际 `generationContext`。调用 upstream 之前等待该审计完成；审计失败不发请求。发送与记录使用同一凭据脱敏后的上下文，不宣称是供应商 HTTP wire payload。
- `agent.model_request` 新增可选 `generationInput`，沿用版本化 `AgentTextBody`；正文经过 `RecordedModelContextSchema` 校验，包含实际 systemPrompt、tools 与完整 messages，保留原生 tool-call ID、完整普通参数、校验错误、isError 与多工具批次结构。不存在第三方 Provider 上下文时不伪造该字段。
- 复用 `recordedContext` 把图片变为已登记 artifact 引用；大于既有 8192 字节阈值的正文沿用模型输入 artifact spill。生产 History 按事件 run 归属解析并核对正文/图片的 hash 与 byteLength。缺失、损坏、不合法快照失败，不回退为可认证的投影。
- 字符串文本继续按既有凭据规则脱敏，补充明确敏感键的字符串值以及原生错误中普通/转义 JSON 字符串的同类键值。工具 schema 中 token/apiKey 的对象定义与普通参数不因键名而替换；结构脱敏不修改 SDK 状态。快照是凭据脱敏后的实际 Provider Context，并非保留全部敏感字节。
- 重建优先 `generationInput` 中的实际上下文，标记 `contextSource=generation_snapshot`；旧消息/工具日志仍按 `event_projection` 重建。`contentComplete` 保留附件内容完整性含义；来源标记区分实际快照与旧投影，不能以完整投影冒充实际输入。
- 原 `digest` 仍是 adapter 对完整 model 与实际 sanitized Context 计算的请求身份。本次只保存 Context，不承诺能以 model ID 重算该 digest。附件 hash 与已提交事件 checksum 校验已保存快照；upstream 传输与供应商接受不由该快照证明。
- 全日志重建仍先解析旧投影中引用的附件；某个较早投影附件缺失时，后续完整快照也可能被整体 fail-closed 阻断。这是现有可用性边界，不通过预扫描或隐式忽略附件扩大成功条件。
- 正式 review 发布/恢复只有实际 generation 快照的完整输入能认证 inspection。旧无 review 契约的自定义路径保留旧校验；旧已声明该契约但无快照的 attempt 可只读查看，不能借投影认证新恢复发布。已发布历史报告不改写、不迁移。

## 备选方案

**保存更多类型摘要或仅比较 digest 字段。** 无法恢复 SDK 原生错误、整批工具与实际转换结果；复制请求 digest 也不能证明重建内容等于原输入。选已有 artifact、schema、事件与 run 解析路径，直接保存实际 Context。

**保存原始 base64、凭据或 Provider wire 请求。** 增加敏感数据和重复存储；本需求只需证明模型生成时拿到的公开上下文。图片沿用受校验引用，凭据在发送与持久化前使用同一脱敏，配置/auth 不进入快照。

## 影响

可选字段允许旧日志继续读取，新重建对象公开来源；旧读端不认识该字段，因此实际快照及其认证依赖新版本，不保证回滚旧版本仍具有新认证能力。每次 generation 新增本地 artifact/hash 开销，受原预算、调用取消与失败保护，不增加模型请求或额度。既有摘要压缩输入保持独立 `compactionInput`，不能代替 generation 快照。

## 验证

native Pi 的零付费测试逐次对照 fake upstream 实际 sanitized systemPrompt/messages/tools 与重建结果，覆盖对象参数、原生非法参数拒绝、原生错误、整批工具、transform/prune 前后及重新打开事件日志。检查结构敏感键、普通/转义 JSON 错误文本脱敏且 schema 不被替换；大正文 artifact spill、缺失/损坏、非法 JSON/schema、旧完整投影降级与实际空上下文覆盖旧消息均有逆例。

图片测试验证 generation 正文和 manifest 引用可解析且缺失/损坏不能认证。生产 History 入口验证同 hash 图片在两个 run 各自归属，第二 run 缺失不能由第一 run 替代；读取不改变事件、目录与 writer.lock。发布认证的独立逆例验证完整实际 inspection、旧投影、空实际消息和 assistant 摘要的差异。测试不证明真实供应商传输、模型接受或语义结论正确。
