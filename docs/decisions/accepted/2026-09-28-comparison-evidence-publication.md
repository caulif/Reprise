# 决策：Comparison 证据身份与可达发布

状态：accepted

## 问题

封存的历史 HTML 终稿只作为导航线索，无法直接以 catalog 短引用渲染；派生 HTML 丢失扩展名；根报告中的派生证据链接仍指向 attempt 相对路径，而 `report-model.json` 只保留旧事件/artifact 身份。这使证据虽被注册却不便检查，发布后有引用断链和机器可读身份丢失。

## 决定

- 将已封存的可打开历史终稿登记为 `historical_artifact` catalog 链接，保留其 `finals/` bundle；渲染仍只接受 Host 映射的短引用与受控挂载。
- 历史终稿在 attempt 草稿中使用 `finals/` 相对链接；预览将被引用终稿及 HTML bundle 资源复制到受控预览目录，并纳入依赖摘要；发布时改写为实验根目录的 `comparison-attempts/<attemptId>/finals/` 链接。三种页面各自只使用其可访问的根目录。
- 新派生证据按内容 hash 保存，识别支持的扩展名并核对 HTML/SVG/PNG/JSON 的基本内容类型。旧无后缀文件不迁移、不覆写。
- 根报告发布时只处理 catalog 中 `derived_analysis` 且实际被引用的证据。校验 attempt 内路径、真实路径和 SHA-256，再复制到根 `evidence/<hash>.<ext>` 并改写报告和 model 的链接。恢复发布走同一映射，失败不覆盖旧根报告。
- `report-model.json` 保持原 `evidenceRefs` 的 event/artifact 语义，新增可选 `evidenceIdentities` 保存所引派生证据的短引用、内容 hash 与 source refs。旧 model 继续通过 schema 校验；不把短引用伪装成事件 ID。
- 预览静态 mechanics 排除 template 原型，并将“指标存在”和“指标实际可见”区分。受控渲染器按 Host 固定选择器回传位置与图片加载事实，不开放任意浏览器脚本给模型。配置与时间线明确自定义模型的图片输入声明及实际 Session 能力，不能由声明推断真实网关支持。
- 渲染与报告预览成功结果附现有 `read(format=image)` 参数。只有实际读取产生可审计的原生 image block 才能支持模型目视 claim；review 图片仍不进入双侧比较媒体 catalog。
- 结果页从本次 Comparison 的 `comparison.phase_completed` 事件汇总模型请求、工具调用与压缩次数；候选执行用量单列，比较分析的 Token 与工具费用未采集时明确写未采集，不用候选用量代替。

## 备选方案

**让报告直接引用 attempt 目录。** 这依赖报告所在目录和 attempt 路径的相对位置，搬动或恢复发布时容易断链，也不能校验派生文件是否仍与 catalog 一致，因此采用根目录内容寻址副本。

## 影响

正式 HTML 仍依赖同目录的媒体与证据文件，单独复制 `report.html` 不保证可离线复核。对派生证据的机械校验只证明来源与字节一致，不为自然语言结论背书。新增字段为可选字段，旧报告保持原样；新报告可从已记录的短引用追到来源 hash。

## 验证

离线回归覆盖 HTML 终稿入 catalog、派生类型拒绝、根路径与 hash、旧式 model 兼容、预览 template 误报及主动停止的生命周期。真实模型图像接收能力仍需显式 opt-in 探测。
