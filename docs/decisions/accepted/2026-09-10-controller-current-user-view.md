# 决策：Controller 用户视图只读 current-user-view.md

状态：accepted

延续 [先理解再按视图决策](./2026-09-09-controller-understand-then-view.md) 与 [权限快照与当前视图](./2026-09-09-controller-permissions-view-prompt.md)。替代其中把用户可见快照落在 `view.txt` 的路径约定；按 settlement 区间取助手文本与 `UserVisibleTurn.prompt` 的规则仍有效。

## 问题

Host 同时写入 `view.txt` 与 `current-user-view.md`，两套渲染。Controller prompt 仍要求读 `view.txt`，新视图契约不是运行时依赖。

## 决定

Controller、审计 digest 与回放只依赖 `controller-briefing/current-user-view.md`。每轮不可变副本是 `run/turns/{n}/user-view.md`。不写入、不索引、不压缩 `view.txt`。INDEX.md 与 system/opening/steering/compaction prompt 只指向 `current-user-view.md`。

## 备选方案

**保留 view.txt 作为纯文本摘要。** 两套渲染会漂移，prompt 仍绑定旧路径。

**只改 prompt 仍双写。** 审计与回放继续看到两份事实。

## 影响

[Controller 设计](../../architecture/controller.md)、[实验条件](../../architecture/controller-experiment-conditions.md)。

## 验证

`test/application/controller-briefing.test.ts` 断言 briefing 根没有 `view.txt`，digest 与 waiting/completed 文本来自 `current-user-view.md`。`test/core/architecture.test.ts` 拒绝 `controller-briefing.ts` 与 `controller-agent.ts` 出现 `view.txt`。`test/snapshots/controller-system-prompt.txt` 与源码一致。`npm run check` 必须通过。
