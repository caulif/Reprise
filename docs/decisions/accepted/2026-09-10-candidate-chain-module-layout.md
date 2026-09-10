# 决策：候选链模块目录与文件名

状态：accepted

延续 [ProductPack 端口](./2026-09-09-product-pack-ports.md) 与 [UserVisibleTurn 时间线](./2026-09-10-user-visible-turn-timeline.md)。目标见 [执行指南](../../plan/application-candidate-agent-refactor-execution.md) 阶段 10。

## 问题

内置 Pack 落在 `src/products/{codex,claude-code}/`，observations 物化与 launch 校验散落在 Application 文件名，Registry 与测试用 `runtime-port` / `activity` 指代 runtime 与投影。执行指南要求目标树，且不保留旧路径。

## 决定

内置 Pack 位于 `src/products/packs/{codex,claude-code}/`，文件为 `{runtime,runner,protocol,projection}.ts`。Host history 入口是 `src/products/history/{types,discover,read,normalize,source-refs,observations-materializer}.ts`。Runtime 进程在 `src/infrastructure/process/{spawn,terminate,stdio}.ts`。Controller 查询投影在 `controller-queries.ts`。Recovery 输入在 `recovery/input.ts`。Automated tests 在 `test/{core,products,application,candidate,tui,cli}/`。`ProductPack` 同时要求 `history`、`runtime`、`projection`。不保留旧路径的兼容转发。Intake 排序、资格过滤、候选默认模型和 `--sessions-dir` 由 Application 提供；TUI/CLI 只在进程根加载 Pack registry。

本地插件仍可按 `capabilities` 只提供 history 或 runtime；内置 Pack 与 Fake Pack 三者齐全。

## 备选方案

**保留旧目录并加 re-export。** 计划禁止双轨。

**把 observations 物化留在 Application。** 与执行指南的 history 模块责任不一致。

## 影响

`reprise/pack-api` 的 major 仍为 3。Application、测试、脚本和文档链接改到新路径。`test/core/architecture.test.ts` 禁止再出现旧目录。

## 验证

`test/core/architecture.test.ts` 拒绝 `src/products/codex`、`observation-files.ts`、`candidate-launch.ts`、`candidate-runtime-journal.ts`、`run-preflight.ts`、`products/shared/process.ts`，并要求 history/process/controller-queries/recovery/input、Pack `runner`/`protocol` 以及 `products/shared/{runtime-host,turn-wait,session-summaries}.ts` 存在。`products/shared` 不得导入 Pack `protocol`/`projection`。TUI/CLI 除进程根外不得导入 `products/history`、`products/shared`、`pack-access` 或 `products/index`。`test/product-pack-ports.test.ts` 与 Pack 契约测试走 `products/packs/`。`npm run check` 必须通过。
