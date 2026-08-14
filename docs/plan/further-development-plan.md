# Reprise 下一阶段开发计划

## 目标

让用户运行一个真实 Codex 实验时，能在终端实时看见可验证的执行过程，结束后仍可通过 trace 和 HTML 报告复核。

固定配置：

- Candidate：`gpt-5.6-luna / high`
- Controller、Comparison：`gpt-5.6-terra / medium`
- 数据事实：现有 `ExperimentStore` 追加日志
- 运行环境：冻结源码的本地隔离副本

## 原则

1. TUI 是事件日志的只读视图，不承担实验状态机。
2. 只显示系统实际公开并持久化的内容，不伪造隐藏 chain-of-thought。
3. 复用现有 `pi-tui`、Runtime、CandidateRun、Store、Agent 和报告代码，不增加依赖。
4. 过滤 token delta 和空 reasoning 等噪声；保留原始事件供事后审计。
5. `q`/`Esc` 只关闭视图，不取消或改变实验。
6. 先完成一条真实路径；不做 dashboard、主题、插件、daemon 或第二 Product Pack。

## 用户应看到什么

一条按时间排序的主时间线：

- Harness：运行创建、状态变化、delivery、turn settlement、artifact、cleanup、outcome、报告；
- Target：公开 plan、命令开始/完成及短输出、可见回复、runtime warning/error；
- Controller：评估开始、最终 decision/rationale、真正发送给 Target 的文本；
- Comparison：开始、完成及 fallback 状态。

模型 provider 未公开的内部推理不在事件中，因此不展示，也不以“思考过程”名义猜测。公开 plan、命令和可见回复是可审计的行为轨迹。

## 实施顺序

### U1：真实 runner 的实时主时间线

在 Store 成功追加事件后通知只读 observer；TUI 只投影关键信息。真实 smoke 与本地历史 C runner接受 `--tui`。

完成判据：运行中可看到上述三类来源；高频 delta 不触发重绘；TUI 异常不改变已持久化事实；结束显示报告 URL。

### U2：正式用户入口

在现有 CLI 增加真实 `compare --task <absolute-task.json> --tui`，调用同一个真实 runner。任务文件只声明不能安全推断的仓库、base commit、prompt、允许路径和验证命令。

完成判据：无效输入在创建工作区前失败；CLI 不复制 runner；Candidate 和 Experiment Application 模型保持固定。

### U3：一条新的用户验收任务

由用户选择新的独立历史任务，完成冻结、隔离运行、检查、范围审计、trace replay 和报告查看。

完成判据：测试与范围事实落盘，events JSONL 序号连续并可 replay，原仓库和全局 Codex 配置未修改。

## 本阶段不做

- 隐藏 chain-of-thought 获取或模拟；
- 多面板布局、主题、鼠标交互和实验列表；
- TUI 内编辑任务、模型、权限或预算；
- 通用工作流 DSL、插件系统、后台服务；
- 自动发现任意历史会话；
- 提交历史 C runner、实验产物或本规划文档。

## 验证

代码完成后只执行一次构建、直接相关的 Store/时间线/CLI 测试、`git diff --check` 和 Ponytail 审查。真实模型运行由显式环境变量和绝对数据目录保护；不把 protocol smoke 称为 benchmark。
