# Changelog

本文件记录用户可见变更。格式接近 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本遵循 SemVer；破坏性 on-disk / 事件格式必须写迁移、兼容性和回滚提示。

## [Unreleased]

### Changed

- Comparison 改由 Agent 写标题、限制与正文片段，Host 组装并校验整页；预览后修改内容必须重新检查，失败不会覆盖上一次成功报告。
- Comparison 移除旧整页 HTML 创作入口及旧 `report-model.json` 格式 1/无版本/四区槽位读取；仅接受当前 formatVersion 2，不自动迁移或删除历史文件。回滚版本不理解新内容文件。
- 对照调查提供能力清单、受管页面观察、受限 HTTPS 获取、CSV/JSON/PDF/Office 文本提取及可选的 ffprobe 媒体检查、ffmpeg 单帧提取和 Tesseract OCR 命令。LibreOffice 转换仍不支持；缺浏览器时保留文件与文本证据，并明确标出无法完成的视觉检查。

### Fixed

- 派生证据链接在预览和正式报告中可打开，发布前核对原始字节；DOCX 超链接前后的文字维持文档顺序。
- 浏览器截图记录实际耗时、来源和动作，不再把长时间交互误作超出渲染采样上限。

### Added

- 包名改为 scoped `@caulif/reprise`（避开 npmjs 无关同名包 `reprise`），并提供 TUI、headless `prepare`/`run`/`compare`、查询和取消命令。
- openai-compatible 内部模型可声明「支持图片输入」（`inputCapabilities`）；默认仍为仅 text。Pi catalog 视觉能力以目录为准。text-only 会话不向模型发送原生 image block。
- Comparison：text-only 仍可将已注册图片写入报告供人阅读；`data-claim="visual"` 须关联本 Session 实际交付的媒体 contentHash；seed/briefing 物化时对可用文件写入同口径 `contentHash`。

### Added

- Comparison attempt 动态证据 catalog：append-only 短引用、`register_evidence`、事件 `comparison.evidence_registered`；Host 挂载真实 `render_artifact` / `preview_report`（冻结 finals/candidate snapshot 映射；`media/*` 文档 `bundleRoot` 限于 `attemptRoot/media`）。

### Changed

- TUI 从历史会话核对页冻结 `TaskCase`，在隔离副本中恢复后让用户选择候选 Product Pack 与该 Pack 的模型；确认页 `Enter` 才启动候选，运行页保持只读。
- Recovery、Controller、Comparison 共用 Harness 内部模型配置；第三方凭据可保存于 Git 忽略的 `.reprise/harness-model.json` 或使用 `env:NAME`，官方 Pi catalog 使用 `pi /login`。密钥不进入事件、artifact 或报告。
- 恢复、候选运行和对照在同一实验时间线中显示压缩后的工具活动、Controller 决策、候选可见事件、结果和本地报告入口；候选隔离副本在运行后保留供排障，对照读取封存快照。
- Comparison 使用固定价格快照计算可用的成本信息；缺少 token 或价格目录时明确显示未记录或未配置。
- Recovery 在源目录超过复制预算时使用稀疏工作区与只读 `source/`，并以 `ready`/`blocked` 结论和简短摘要结束；源目录写保护、凭据边界和真实调用显式 opt-in 保持有效。

### Fixed

- 同一 Experiment 的不同 run 现在使用独立的 Controller、CandidateRun、runtime、Recovery 与 artifact operation ID；Recovery 的报告、attempt、诊断和默认 baseline 也按 run 隔离。离线 fake Runtime 已验证从同一封存起点连续完成两次运行。延后 Comparison 模式中的早期失败也会结束 `candidateFinished` 等待。
- 事件日志尾部修复按 UTF-8 字节保留完整前缀；已提交事件为不可变 JSON 快照。Artifact 读取和幂等重试校验 manifest、正文与对应提交事件，冲突或未提交残留明确失败。
- Comparison Agent Session 不再 `timeoutMs: 0` 无限等待；改为 harness `budget.callTimeoutMs`（默认 24 小时）。超时映射为 `agent_timeout`；用户取消优先且不重试。Controller 仍保持无界。
- HTTP 520 归入 `transient_upstream`，Recovery 可使用既有有界重试，不再误判为不可重试的 `unknown`。
- Comparison `shell_exec` 在应用层快速拒绝直接启动 Chrome/Edge/Firefox 及浏览器探测标志；错误提示改用 `render_artifact` / `preview_report`。底层 60s 超时、进程树终止与 AbortSignal 不变。
