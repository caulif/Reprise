# Changelog

本文件记录用户可见变更。格式接近 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本遵循 SemVer；破坏性 on-disk / 事件格式必须写迁移、兼容性和回滚提示。

## [Unreleased]

### Changed

- Harness 内部模型默认按第三方网关注册（`reasoning` 缺省关闭）；官方订阅改走 Pi catalog 与 `pi /login`。
- 运行页页脚只保留取消与按键说明，去掉不能可靠操作的画布快捷键和伪输入行。结果页不再列出查找。
- 候选隔离副本在 run 结束后保留在 `environment/runs/{runId}`，`release` 只结束活动句柄，不删除该目录。结果页列出该路径并用 `w` 打开；Comparison 的 `candidate/` 读这棵活副本。
- 内部 Agent 同批读可并行、写顺序执行；上下文用 Pi compact（summary + tail）而不是 digest 占位；不再用工具调用次数或相同输入拦截截断。
- 恢复、控制器和对照进行中的 TUI 显示压缩后的工具过程（动词、对象、阶段），而不是只显示工具名或空白。

### Added

- 公开协作入口：贡献指南、安全政策、行为准则、支持与治理说明，以及 Issue / PR 模板。
- 发布清单、事故复盘模板，以及 pack allowlist / production audit / secret 扫描 / 分层 import 门禁。
