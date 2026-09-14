# Changelog

本文件记录用户可见变更。格式接近 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本遵循 SemVer；破坏性 on-disk / 事件格式必须写迁移、兼容性和回滚提示。

## [Unreleased]

### Changed

- Harness 内部模型默认按第三方网关注册（`reasoning` 缺省关闭）；官方订阅改走 Pi catalog 与 `pi /login`。
- 运行主列用左缘分内部 / 候选，正文不再整句染色；折叠变暗；失败独立红；列尾时钟钉在右侧。此刻行只留列尾，恢复标题只留顶栏。
- 真终端滚轮与单击交给应用：视口库不再先消费 SGR 64/65。
- 运行页页脚只保留取消与按键说明，去掉不能可靠操作的画布快捷键和伪输入行。结果页不再列出查找。
- 候选隔离副本在 run 结束后保留在 `environment/runs/{runId}`，`release` 只结束活动句柄，不删除该目录。结果页列出该路径并用 `w` 打开；Comparison 的 `candidate/` 读这棵活副本。
- 内部 Agent 同批读可并行、写顺序执行；上下文用 Pi compact（summary + tail）而不是 digest 占位；不再用工具调用次数或相同输入拦截截断。
- 恢复、控制器和对照进行中的 TUI 显示压缩后的工具过程（动词、对象、阶段），而不是只显示工具名或空白。

- 对照报告由 Host 模板渲染任务、状态、指标和差异插槽；失败页共用该外壳并区分失败类别。
- Recovery 在源目录超过复制预算时改为稀疏工作区加只读 `source/`，不再把整树复制失败当成无法启动。
- Recovery 最终信封带一句话 `summary`；checkpoint 种子也走同一 Agent；blocked 与失败的新 baseline `match` 为 `observational`。
- Recovery 按可观察材料建立合理起点：未知缺口不自动阻塞；Host 路径清单与命令失败不改写 Agent 结论；`blocked` 作为正常停手展示。
- Recovery 期间用 NTFS ACL 拒绝写入用户 source，不再靠 shell 命令文本识别写操作；readiness 只写入诊断，不阻止 `ready` 发布。
- 发布清单、事故复盘模板，以及 pack allowlist / production audit / secret 扫描 / 分层 import 门禁。
