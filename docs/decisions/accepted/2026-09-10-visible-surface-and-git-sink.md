# 决策：区间内公开正文拼接与 Git Harness sink

状态：accepted
日期：2026-09-10

## 问题

一轮 settled 区间里可以有多段公开助手 `text`。Pack 只用最后一段生成 `UserVisibleTurn`，Controller 与 Comparison 读到残缺表面。隔离副本仍保留用户 GitHub `origin`，候选 `git push` 打到真远端。

## 决定

- `TargetRunFacts.assistantTexts` 按事件顺序收集公开正文；`finalMessage` 仍是该集合最后一段（整次 run 摘要、Intake、`baseline.finalMessage` 不变）。
- `projectUserVisibleTurn` 的 `assistantText` 是该 turn 切片上各段 `trim` 后用 `\n\n` 拼接。thinking / tool_use 不进表面。Controller `turnVisibleText`、`user-view.md`、`visible.txt` 同源；Comparison 只读挂载同一 `turns/`，不另写投影。
- Recovery 继续只读冻结 `observations/`，不消费 `UserVisibleTurn`。
- Harness 拥有的树（Recovery staging、published baseline、`prepareRun` 副本）里，每个 Git 仓库的 `origin`/`pushurl` 指向本实验 `environment/git-sinks/{id}` bare sink。候选进程去掉 `GITHUB_TOKEN`/`GH_TOKEN`，并用 sink `gitconfig`（`GIT_CONFIG_GLOBAL` / `NOSYSTEM`）对已记录 origin URL 做 `insteadOf`；不改写 `HOME`/`USERPROFILE`。Comparison 读 `candidate/git-sink-refs.txt`，不把用户 GitHub 当实验远端。

区间取视图仍遵守 [按 settlement 取视图](./2026-09-09-controller-permissions-view-prompt.md)；本决定补上区间内部全部公开 text。

## 备选方案

**只改 Claude Pack。** Codex 一轮多条 `agentMessage` 同样截断。

**整次 run 的 `finalMessage` 也拼接。** 破坏会话预览与对照摘要语义。

**删除副本 remote 让 push 失败。** 扭曲「请提交并推送」任务。

**只抽凭据、不改 origin。** URL 仍是真仓库。

## 影响

[Controller](../../architecture/controller.md)、[Environment](../../architecture/environment.md)、[Comparison](../../architecture/comparison.md)、[Runtime 事件](./2026-09-09-candidate-runtime-events.md)。

未知 GitHub URL 的 push 第一版仍标 `externalWorld: uncontrolled`。

## 验证

- `test/products/user-visible-surface.test.ts`：三帧公开 text 的表面含第一段与长文，不等于收束；thinking 不出现；整 run `finalMessage` 仍是最后一段；`user-view.md` / `visible.txt` 含第一段。
- `test/core/git-sink.test.ts`：嵌套仓 `prepareRun` 后 origin 不是用户远端；对 sink `push` 前进；对用户远端 URL `push` 不前进用户 HEAD。
- `npm run check`。
