# 决策：运行事件诊断与阶段时钟由局部投影对象持有

状态：accepted

## 问题

运行阶段、最后可见活动、重连提示、报告 attempt 与 Recovery/Candidate/Comparison 时钟散落在 IntakeTui。controller-run 的阶段 reset 与导航 showError 重复清理诊断字段，页面和其他控制器也可以直接改写这些投影。

## 决定

[RunDiagnostics](../../../src/tui/run-diagnostics.ts) 拥有事件诊断与阶段时钟，外部仅能读取快照。observe 复用既有 phase-state、candidate-run-phase 事件推导；beginPhase 清空新阶段的诊断而保留前序阶段时钟，startClock/freezeClock 接受调用方提供的时间。错误入口使用统一 reset 清空全部诊断与时钟，包括过期的 runStartedAt。

对象只接受事件、准备阶段、局部时钟范围和数字时间，不接收 IntakeTui、ControllerHandle、workflow 或 ExperimentHandle，不持有页面、计时器、取消请求和 navigation token。CandidateRun 的业务状态机仍是应用层既有 assertTransition；machineState 只是已公开事件的显示值。

控制器继续拥有事件转发顺序、timeline append/index/selection、运行计时器、generation/请求 guard、取消/清理与异步工作流。preparePhase/detail 继续由准备流程维护。Comparison 开始后晚到 Candidate 事件仍使用既有 shouldApplyLivePhase 规则，不新增终态推断。

## 备选方案

**移动接收整个控制器的重置函数。** 无法阻止跨模块直接改写字段。

**让此对象拥有整个运行生命周期。** 把 workflow、取消和页面也移入此对象，会建立另一套运行生命周期；本次边界只覆盖事件投影。

## 影响

IntakeTui 和 ControllerHandle 用一个局部对象代替公开诊断与时钟字段。界面字段仍按原投影形状生成，不改变事件、on-disk、模型输入或 Runtime 契约。

## 验证

验证覆盖同一已提交事件经 observe 的 live 与磁盘重开阶段投影一致、重复 Comparison 重新打开其时钟、晚到 Candidate 活动不覆盖 Comparison、先前快照不被后续事件改写、真实错误导航清空诊断后再次开始阶段。该一致性检查不包含本地 startClock/freezeClock 的 nowMs 时钟，不声称它们可以由磁盘完整重建。原真实工作流取消、startup、比较选择与实际控制器输入回归保留；不调用付费模型。
