# 决策：Comparison 原生图片链路与版本绑定续审

状态：accepted

## 问题

受控渲染只返回图片引用，不能证明模型看到了图片。模型能力声明、Case 二进制授权、工具交付和最终请求是独立边界。按工具 JSON 总长度裁剪会吞掉图片。审阅提交新草稿会失效旧预览，错误的 compose 回执和缺少续审使可修复的草稿最终失败。

## 决定

- Session 以有效 Provider 模型冻结输入能力，Session 声明冲突即取消。自定义配置缺省 text-only，catalog 以 Pi 目录为准；审计有效身份、API、能力来源与无凭据配置指纹。
- `render_artifact` / `preview_report` 新增可选 `includeImages`，默认文本引用。原生图片须 Case `privacy.allowBinary` 授权并通过模型能力过滤，媒体存在不扩大 workspace 二进制权限。
- 仅附登记后的 PNG，检查真实 attempt 路径、文件字节 hash、长度和 PNG 头部尺寸。最多 4 张、单张 3 MiB、合计 8 MiB、单张 9,216,000 像素，不交付部分失败的图片集合。头部检查不是完整解码或视觉质量验收。
- 工具结果、压缩 retained tail、最终 Pi 请求保存不可变图片附件的 hash、长度和 artifactId，日志不存 base64。重建校验附件；旧日志缺附件不能作为完整图片输入。
- 视觉声明在存在最终请求清单时仅认可这些清单，不能以尚未发给 Provider 的工具结果代替；恢复读取同样规则。无清单的历史日志保留原有交付事实兼容，不补造新请求。
- 文本裁剪保留图片，活跃上下文最多保留最近 12 个原生图片块，旧图换成带 hash 和重新读取提示的文本。最终请求清单记录过滤后的图片。`review-*` 不进入双侧证据 catalog。
- 提交回执反映实际阶段，相同 digest/revision 的幂等提交保留预览，不同版本失效旧预览。review 最多再续审两次，无进展立即退出；发布仍绑定当前版本成功预览、正常完成和未取消。
- `config test-image` 为一次性无重试探测，必须 `REPRISE_RUN_IMAGE_PROBE=1`。随机条纹的答案只在 Host，结果按配置指纹保存。`image-status` 显示未探测、过期或结果；声明不是探测，探测也不是完整真实任务验收。

## 备选方案

**自动启用图片或无限重试。** 前者扩大授权，后者扩大费用，均拒绝。保留 read 兼容，同时在受控工具提供原生交付，减少引用返回后遗漏读取。独立视觉模型属于真实任务验收后的后续架构项，不在本次修改范围。

## 影响

新参数可选，历史配置和事件继续读取；新持久化经过 schema 检查。没有改变 CandidateRun、Runtime/Pack 或默认模型，没有自动调用外部服务。探测文件不含密钥、答案或模型原始回复。回滚代码不迁移旧实验，旧读端可能忽略新字段。

## 验证

离线回归覆盖改稿续审、无限修订退出、能力冲突、授权、hash、预算、取消、压缩与重启重建。fake Provider 从 PNG 像素得到条纹顺序，覆盖错误答案、上游错误、text-only 和缺少 opt-in 的零请求。执行 `npm run check`；真实模型验收须独立 opt-in，不能从 fake 结果推断支持和质量。

相关决定：[草稿发布](2026-09-26-comparison-draft-publication.md)、[受控渲染](2026-09-19-controlled-artifact-render.md)、[证据发布](2026-09-28-comparison-evidence-publication.md)。事实归宿：[证据与 Comparison](../../architecture/evidence-and-comparison.md)、[使用指南](../../usage.md)。
