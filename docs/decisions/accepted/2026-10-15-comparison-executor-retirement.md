# 决策：退役旧 Comparison 执行策略并保留共享与历史契约

状态：accepted

## 问题

默认工厂已使用自主 Comparison，旧 executor 没有生产构造入口，但阶段策略、提示词和测试仍互相维持引用。直接保留会继续掩盖默认路径的缺口；直接删除引用旧构造的测试又会丢掉 Host、发布、媒体和历史认证不变量。P08b1 与 P08b2 已先迁移共享回归并修正当前路径缺口，本批完成剩余执行策略退役。

## 决定

删除旧 ComparisonAgent、mandatory investigate/compose/review、fresh author/reviewer、周期 findings 保存、局部阶段截止及工具曝光策略。默认工厂只构造 AutonomousComparisonAgent，短引用和结果断言依赖中立契约。旧内部模块的兼容 re-export 不继续作为死执行器存活的理由。

保留默认 24 小时总时间、显式请求/工具/费用硬限制、canonical tool 去重、缺失 usage/价格时的费用保护、资源完成审计与 P06 共享资源解析。总计时不会被阶段转换、output-limit 续写或原有阶段字段重置；不再执行调查软额度、审阅预留或局部阶段扩展。资源 summary 保持原 schema 的计数、未知价格及兼容字段，phase 描述自主会话而非虚构 compose 阶段。

output-limit 仅在同 Session 继续未完成动作，每次真实请求和工具仍受调用方总截止及硬限制。read 的 available/truncated/offset/byteLength/returnedBytes/totalBytes/nextCursor 白名单进入实际模型工具结果；缺失、不合法值不补零或 false。原始 JSON、图片块及内部交付 token 经装饰后仍保留，不带旧阶段指导语。

保留旧 on-disk schema、findings/disposition/inspection 与独立审阅的历史读取及认证、真实 fixture 和注入历史协议 Port 的边界。旧 evidence_checkpoint schema 继续接受原 investigate/review 记录，不为了自主默认路径伪造旧阶段。历史工具/预览、跨 run ownership、hash 和来源读取不会随 executor 退役删除。

## 备选方案

**保留 executor 只供旧测试运行**：依然无法证明默认生产路径，并留下未来误装配入口。先迁移共享回归，再按断言去掉策略约束。

**把所有 legacy 执行和历史读取一起删除**：会损坏旧报告与已提交事件的认证；旧数据读取与执行策略分别清理。

## 影响

不修改历史记录、不降低覆盖率、不新增真实模型费用。旧内部 ComparisonAgent import 不再存在；当前内部类型统一使用 comparison-contract。公共包入口没有导出旧 executor。仍可注入实现既有 Port 的调用方，历史能力字段继续决定认证方式。旧阶段提示词快照没有生产消费者，随策略移除；Controller、Recovery、report shell 快照保留。

历史 ADR 引用已退役实现时，链接固定到退役前 Git 提交，保留正文的历史解释。本文不把旧阶段要求继续写成默认能力，也不把旧报告自动降级到自主认证。

## 验证

当前工厂的 offline Pi 流实际执行工具、提交、预览和后续 generation；没有手造 completed Port 替代发布。本批新增 1/2 次 native output-limit 后真实发布、分页 read coverage 后续实际请求、hard attempt deadline 在 per-call timeout=0 时仍生效、异步发布校验期间取消拒绝 completed。旧通用 native-media 测试原样迁出；持久化 findings 与 inspection 继续运行。

原引用旧 executor 的文件按下表逐项处理，表中的路径均相对 test/application。只退休列明的策略要求，未把 28 个文件当作整体删除清单。

| 原测试文件 | 保留不变量及现行回归 | 退休的执行策略 |
|---|---|---|
| agent-host | 原文件保留全部 Controller/Host；Comparison 部分走真实工厂 | 固定旧 prompt 文案 |
| comparison-agent-phases | agent-native-media 原样保留 2 项；autonomous-publication 保留取消时 Candidate outcome；contract/report 保留引用与 Host 区；current-host-invariants 保留 quote/catalog；current-continuation 保留真实续写 | 固定四轮、envelope repair、fresh review 与 phase tools |
| comparison-agent-timeout | 原文件迁当前实现，保留 3 项并新增 per-call=0 硬截止 | envelope repair 的阶段命名 |
| comparison-author-yield | decision-draft-publication、submission-flow 保留接受、预览和空最终消息边界 | 作者强制 yield 到独立 reviewer |
| comparison-closure-deadline | comparison-discovery、findings-delta 与历史 schema 保留 pending 身份、接受状态及持久化失败 | Host 在阶段截止强制关闭问题再 compose |
| comparison-convergence | autonomous、agent-timeout 保留总截止、取消、资源完成及错误聚合 | findings 无进展轮次和 phase 拒绝 |
| comparison-decision-draft-publication | 原文件走当前工厂，保留不确定性、修订、实际图像/文字预览投递、预览后 Provider 失败 | 固定 source/audit/presentation review 轮次 |
| comparison-evaluation-inputs | 原文件保留冻结输入、原 committed 前缀与合法后缀；使用真实当前构造 | 旧 reviewer 故障注入入口 |
| comparison-findings-delta | 原文件保留 schema、完整/增量保存、binding、queued stale、取消和持久化失败；checkpoint 保留每个问题和非目标 finding | 旧 executor publication loop、checkpoint 强制 source-save/独立 review 曝光 |
| comparison-fresh-author | pinned-metrics、agent-host、current-host-invariants 保留任务、指标、引用与实际输入；autonomous 保留取消及清理 | 作者新 Session 旋转和只准提交的工具面 |
| comparison-fresh-review | 当前 hard resource/timeout/policy 回归、真实 publication 与 cleanup 聚合保留 | 独立来源 reviewer、跨阶段软预算和会话旋转 |
| comparison-initial-findings | comparison-discovery/findings-delta 保留实际持久化、schema 和取消；默认自主测试证明无 mandatory findings | 初始保存 checkpoint 与局部截止 |
| comparison-investigation-closure | discovery 与历史 closure schema/认证保留；autonomous 与 timeout 保留取消和硬截止 | 自动截止后转 compose 的旧执行分支 |
| comparison-legacy-resources | agent-timeout 保留 per-call=0 的 hard attempt deadline；resources 保留硬限制 | compose 借用调查软额度 |
| comparison-missing-findings-closure | discovery/findings-delta 保留 missing/stale/save 失败不接受；历史 reader 保留 | mandatory initial save 缺失后的模型恢复阶段 |
| comparison-phase-yield | current-continuation 真实工厂 length 续写；total-time 保留非 output-limit 不续写；autonomous 保留异步 final validation 取消 | source/findings/inspection/preview 的局部 yield 与 checkpoint |
| comparison-pinned-metrics | 原文件改真实工厂、真实 Pi compaction、实际发布与审计重建，坏输入 artifact 逆例 | 独立 reviewer Session 的数量与继承方式 |
| comparison-policy-refusal-publication | 原文件保留真实 readonly 拒绝、scratch exitCode/字节、取消、Provider 与自定义 maxToolCalls 耗尽 | source soft boundary 与强制 delta/audit 顺序 |
| comparison-preview-completion | autonomous-publication、decision-draft-publication 和 current-continuation 保留真正回执进入后续 generation、失败/取消不发布 | preview-only closure 不再生成模型输入的旧策略 |
| comparison-publication-tiers | 原文件保留 layout/contract/media 全部断言，取消改当前实现 | 无 |
| comparison-repair-deadline | agent-timeout 和自主异步 validation 取消保留绝对硬边界 | 独立审阅 repair-read 的局部截止 |
| comparison-report | 原文件保留事实、路径、短 ref/current catalog、Host fingerprint、missing measurement 和直接整页写拒绝；实际工厂覆盖 prompt 边界 | 固定 compose/review 文字 |
| comparison-review-findings | discovery/findings-delta/inspection/history 原 schema 与真实 fixture 保留；当前 publication、timeout、资源失败边界保留 | 独立 findings closure、supplement/source 暴露与固定检查顺序 |
| comparison-review-save-deadline | findings-delta 保留实际持久化失败与取消；current publication 保留旧 preview 不通过 | reviewer 保存局部时窗 |
| comparison-scope-summary-audit | decision-contract/decision-draft/inspection 保留原 scope 声明与不确定性历史认证；当前 decision publication 保留可见关键不确定性 | mandatory findings full-audit 的专用轮次 |
| comparison-submission-flow | 原文件走当前工厂，保留空最终文本、缺/旧 preview、重新 preview、提交前后 Provider 失败 | mandatory findings/audit/checkpoint 次数和内部 phase tag |
| preview-failure-cause | 原文件保留 5 项 timeout/capability/missing preview/诊断边界 | 构造入口改当前实现 |
| compare-exit-after-failure | 原文件保留 lock/listener/process exit，实际关闭当前 Session | 构造入口改当前实现 |

另删除只服务旧策略的 composition-tools、stage-policy、findings-checkpoints、stage-deadlines 测试；resources 原文件仅退休软阶段时窗，保留 24h、硬请求、canonical tool 和费用保护。draft-inspection 的两项反馈/脱敏/token 测试继续通过当前工具装饰器，不借清理删除历史认证。evidence-progress 改为历史 schema 正反例；其旧按阶段 writer 随 executor 退役。

当前规则见[证据与对照](../../architecture/evidence-and-comparison.md#comparison-attempt)。
