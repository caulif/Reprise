# Changelog

本文件记录用户可见变更。格式接近 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本遵循 SemVer；破坏性 on-disk / 事件格式必须写迁移、兼容性和回滚提示。

## [Unreleased]

### Added

- 包名改为 scoped `@caulif/reprise`（避开 npmjs 无关同名包 `reprise`），并提供 TUI、headless `prepare`/`run`/`compare`、查询和取消命令。
- openai-compatible 内部模型可声明「支持图片输入」（`inputCapabilities`）；默认仍为仅 text。Pi catalog 视觉能力以目录为准。text-only 会话不向模型发送原生 image block。

### Changed

- TUI 从历史会话核对页冻结 `TaskCase`，在隔离副本中恢复后让用户选择候选 Product Pack 与该 Pack 的模型；确认页 `Enter` 才启动候选，运行页保持只读。
- Recovery、Controller、Comparison 共用 Harness 内部模型配置；第三方凭据可保存于 Git 忽略的 `.reprise/harness-model.json` 或使用 `env:NAME`，官方 Pi catalog 使用 `pi /login`。密钥不进入事件、artifact 或报告。
- 恢复、候选运行和对照在同一实验时间线中显示压缩后的工具活动、Controller 决策、候选可见事件、结果和本地报告入口；候选隔离副本在运行后保留供排障，对照读取封存快照。
- Comparison 使用固定价格快照计算可用的成本信息；缺少 token 或价格目录时明确显示未记录或未配置。
- Recovery 在源目录超过复制预算时使用稀疏工作区与只读 `source/`，并以 `ready`/`blocked` 结论和简短摘要结束；源目录写保护、凭据边界和真实调用显式 opt-in 保持有效。

### Fixed

- HTTP 520 归入 `transient_upstream`，Recovery 可使用既有有界重试，不再误判为不可重试的 `unknown`。
