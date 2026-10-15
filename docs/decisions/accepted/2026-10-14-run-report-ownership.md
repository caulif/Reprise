# 决策：按已提交运行事实选择 run 并绑定 Comparison 报告

状态：accepted

## 问题

目录名的字母顺序不是运行时间，实验根级 Comparison 便利文件也不带运行归属。两个 run 或同一 run 重比后，History 可把旧 run 与另一 run 的新报告组合，且此前成功报告的原路径会被覆盖。全日志完成状态和输入缺失诊断也可能污染当前 run。

## 决定

默认运行按校验后的 run.attempt_created 提交顺序选择；仅重比默认跳过未完成 run，显式 runId 从不回退。旧无日志目录用 schema/owner 校验后的 attempt/record 时间；无时间或最新并列的确定性顺序不代表最新，查询明确给出 unknown ordering；默认重比要求显式 runId，只有唯一合法 finished 可直接选择。record 与 manifest 的完整 attempt 必须一致，该 run 有生命周期日志时还核对创建与 finished 事件，其他 run 和 Comparison 事件不使旧运行失去兼容资格；没有相应提交的孤立 record 不认作新格式完成事实。旧无日志合法 finished record 保留读取和显式比较兼容，旧报告始终不能据根投影认领 run。已提交 artifactRefs 原值/顺序必须保留，无本 run 提交锚点的旧 record 仅接受精确本 case 或本实验/本 run 的单 owner refs，跨 run、双 owner 与未绑定 run 的引用拒绝认证；仅允许额外一个有晚于 finished 提交的本 run host-trace.json；跨 run 已提交 Recovery refs 不被一刀切拒绝。

Comparison 保留同深度唯一 HTML，attempt result 清单绑定 experimentId/runId/attemptId/invocation/path/SHA-256，并在清单写好后提交 report.created owner。只有事件、清单、实际内容及 owner 一致才确认，文件写完但未提交仍不确认。完成 invocation 与报告发布是不同事实，发布缺失不能从根 report.html 补齐。失败、取消或未完成重比只可引用同 run 的此前成功报告。

同深度文件继续引用内容寻址 media/evidence，以及按 attempt 和 dependency digest 隔离的 historical finals；最终 report model 保存到本 attempt。便利根文件仍兼容旧调用方，新读端不以它们为权威。旧报告原样保留并明确 unknown/unconfirmed。

Persisted comparison 的写租约先于 activity、订阅和 Agent 初始化，并在取得租约后重读选择。租约争抢失败不修改另一活动；成功或失败都按精确 activity 对象退休自身活动，再关闭 Store，清理错误与原始错误聚合，不能吞掉。

## 备选方案

**按 mtime 或 UUID 排序。** 复制、修改文件和随机 ID 都不能证明创建先后，已提交序列更明确。

**只给根 comparison.json 加 runId。** 仍不能保留旧 HTML 和识别部分发布；单次根文件写入失败也会让状态和内容串线。

**将全部发布改成独立深层 bundle。** 会扩大 media、derived evidence 和 sealed finals 的链接重写；唯一根层文件以较小改动保留当前发布边界及资源归属。

## 影响

[运行目录选择](../../../src/application/experiment-layout.ts)、[历史查询](../../../src/application/experiment-history-list.ts)、[重比](../../../src/application/experiment-compare-persisted.ts)和[报告归属](../../../src/application/comparison-report-ownership.ts)采用同一事实来源。新增[owner schema](../../../src/core/comparison-report-owner-schema.ts)和 attempt result；没有原地数据迁移，旧读端仍可用便利根文件，新读端诚实标旧数据未知。TUI 报告分类与点击同步识别唯一路径。

启动失败通过已提交 run.startup_failed 与核心 RunStartupFailureSchema，按同一 committed attempt owner 显示 failed/cancelled、stage 和诊断；即使 experiment.json 尚未写入也保留最小身份及 missing_metadata。最新 attempt 与固定元数据任务冲突时，显示 attempt 实际任务和失败，并保留元数据任务 ID 与明确冲突诊断。孤立失败文件不认证，本契约不将此类 attempt 伪装成 finished RunRecord。P03 的统一 TaskCase reader 后续替换当前 schema 读取，运行与报告 owner 不改变。

## 验证

回归包含逆序 ID、相同时间的提交顺序、未完成最新 run、显式旧 run、完整 attempt 冲突、孤立 record、legacy 时间排序、跨 run 重比、失败保留、缺提交、owner/path/digest 损坏、链接资源及 TUI 报告点击。争抢租约不启动 Agent、不退休现有活动；默认不调用真实模型或 Runtime。当前事实见[证据与对照](../../architecture/evidence-and-comparison.md)。
