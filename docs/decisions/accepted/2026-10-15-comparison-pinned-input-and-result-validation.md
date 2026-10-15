# 决策：自主 Comparison 压缩保留 Host 指标并断言实际结果

状态：accepted

## 问题

旧 fresh-review 测试把 Host 指标钉在旧 reviewer system prompt。当前自主 Session 的指标只在初始 user 消息出现；真实 Pi 压缩可以把该消息替换为未包含指标的摘要。只保留旧测试不能证明自主 Session 的后续请求仍能取得原指标。

共享 assertComparisonResult 还曾先对临时副本补 reportPath，再将调用方的原对象断言为完整结果；原对象实际可能仍没有路径，与 TypeScript narrowing 不一致。

## 决定

当前自主 Session 的 Host 指标同时固定在实际 system prompt 中，保留 unknown 不等于零、时间不能推导费用和估算不是账单的语义。system prompt 经过既有 Session 及 generation 输入审计，压缩后仍随实际模型请求保存；不依赖模型摘要是否忠实保留指标。

当前 Port 完成结果的 assert 检查原对象，要求实际 reportPath=report.html，不在临时副本中修补后假定调用方已被修改。旧 executor 在自己的输出 adapter 中补齐路径后仍可通过；历史 on-disk envelope schema 与读取认证保持原兼容性，不借此修改历史文件。

共享 Host 回归通过当前 createHarnessAgents/PiModelCaller 构造，实际运行 quote_evidence、文件提交、预览、catalog 注册和后续 generation。保留原有事实、路径、短引用、Host 指纹、只读 mount、图片和历史 reader 回归；退休固定 compose/review 文案断言。

## 备选方案

**要求压缩摘要包含所有指标**：摘要是模型生成结果，不能保证不丢失或改写 Host 事实；保留已有压缩指令，但不把其作为唯一保证。

**保留临时规范化并继续使用 asserts**：仍会给调用方错误的字段保证。若未来需要接受不完整 Port 输出，应显式返回经过验证的新对象，而不是让 assert 暗示原输入被补齐。

## 影响

system prompt 小幅增加既有 Host 指标 DTO，不新增外部输入或凭据。已有事件已经保存实际 system prompt 和 generation snapshot，无新增 on-disk 字段。只影响不符合现行 ComparisonResult 类型的 Port 实现：缺少实际 reportPath 的 completed 对象会被拒绝。旧历史 schema/reader 与 P06 配置和总时间预算契约不变。

## 验证

真实工厂的离线 Pi 流运行十六次实际分页读取，触发真正的 Pi compaction。测试摘要明确不含指标，确认 retained 消息已没有原 120000ms 指标正文；随后真实 submit_report、preview_report、空最终文本完成发布。实际后续请求及审计重建的 system prompt 保持原指标，且 contentComplete 为真。逆例修改承载指标的已记录输入 artifact 字节，重建必须报告 attachment_checksum。

另以真正的候选副本变更进入 catalog，执行 Host 字面量引用并验证 hostile markup 被转义；篡改引用、catalog 变化后沿用旧 preview 均拒绝发布，使用新短引用重新提交和预览后才通过。缺 reportPath 的原对象逆例验证断言拒绝且未假装填充该对象。以上无真实付费模型调用，不替代模型质量或浏览器视觉验收。

现行规则见[证据与对照](../../architecture/evidence-and-comparison.md#comparison-attempt)。
