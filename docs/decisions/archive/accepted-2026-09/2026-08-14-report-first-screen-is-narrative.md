# 决策：报告第一屏是判断正文，不是对照条

状态：accepted

## 问题

`report.html` 用四张同权卡片回答一个问题：换模型之后能不能接受这次结果。题头重复停止原因和效率数字，宿主对照条六格里有三格是常量，证据区再列一遍改动路径。Comparison 正文自己已有对照表和回放限制。用户先看到的是 Host 壳，不是判断。

## 决定

报告只渲染四件事：任务一句话加模型/效率一行；白名单 Markdown 正文；最多三条会改变读法的回放限制（`sourceRootKind`、模型别名、非 `controller_satisfied` 的停止或隔离不变量），默认折叠；交付路径，JSON 轨迹折进「原始记录」。不做基线/候选对照条。Host 事实仍独立持久化，不从 Markdown 反解析。

## 备选方案

**保留对照条，只把正文提前。** 这是上一轮的做法。正文提前后，对照条变成第二份摘要，六格信息密度低，问题没有消失。

**把对照条收成一行 Host 摘要。** 比六格短，但仍与 Comparison 对照表抢第一屏。限制句已经承担「不要误读这次回放」的校准。

**让 Comparison 把壳也写成 Markdown。** 壳是 Host 核验事实。交给模型会重新引入排名腔和语言漂移。

## 影响

- `src/report/comparison-report.ts` 不再输出 `.compare` / `.side`。
- 真机 e2e 不再把两列对照条当作报告存在的证据。
- 目录列出、permissionMode、Cron 隔离细节仍进入 Comparison briefing，不进第一屏。

## 验证

`test/comparison-report.test.ts` 断言没有 `Host contrast` / `side baseline`；中文任务题头是「模型 · 回合 · 不是排名」；`sourceRootKind` 与别名出现在折叠限制里，`controller_satisfied` 不出现。
