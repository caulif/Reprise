# Controller 能力评估与契约测试分层

- 日期：2026-08-22
- 状态：accepted

## 决策

Controller 的 deterministic contract lane 保留在 `test/` 并由工程门禁执行；真实模型 capability lane 放在项目目录外的 `controller-eval/`，仅在 `REPRISE_REAL_MODEL=1` 时运行。两者不得以同一个总分表示“Controller 已通过”。

Capability lane 每个最小 case 定义显式用户目标、验收标准、历史用户事实、候选状态、轨迹、可见证据、工具面和不变量，并对每个 case 提供只改变一个事实的反事实。仓库入口为 `npm run evaluate:controller`，产物写到调用方提供的绝对路径；`npm run check` 不运行该入口。运行严格串行，保存脱敏 trace，工具观察只在当前 Controller 决策内使用；若 fixture 没有脚本化的候选执行和新 settled state，不合成第二轮 Controller 请求。消息采用 rubric 评分，不匹配固定自然语言；intent/reason 使用 case 声明的 acceptable family 作为软分类。

## 原因

固定模型输出只能验证协议边界，不能证明 Agent 理解事实、工具和终止条件。把真实模型调用接入工程门禁会引入费用、波动和外部依赖，也会掩盖协议回归结果。外部 Harness 可以单独记录能力分数、硬失败、反事实变化、规范化输入 diff 和耗时，并保留人工复核空间。安全不变量（不泄露内部提示、不接受伪造完成、不错误 satisfied）与 done:blocked 分类分开统计。

## 边界

Harness 不执行候选工具、不修改工作区、不记录模型原文、凭据或敏感内容。生产 Controller 只有在真实 trace 证明共享边界缺陷后才修改；Prompt 或模型参数的对照实验一次只改变一个变量。
