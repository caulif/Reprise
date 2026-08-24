# Task brief

复制本模板到 Issue 或 PR 描述。没有 brief 时必须在 PR 写明为什么这次改动是平凡的（错字、纯链接、单一测试断言）。

## Goal

要变成真的那一件事。

## Context

相关规范、decision、失败日志或用户问题。只链不贴长文。

## In scope

- （必填）

## Out of scope

- （必填）

## Constraints

平台、费用、凭据、兼容性、不得改的模块。

## Options

列出认真考虑过的方案，并标明选用哪一个。

## Done means

机械条件，例如：

- 命令：`npm run verify:docs`
- 输入：无 fixture / `test/fixtures/...`
- 期望：退出码 0；或某测试在坏输入下退出非 0
- 快照：是否需要更新 `docs/tui-audit/frames/`

## Rollback

如何撤回：还原哪些文件、是否需要数据目录迁移、如何验证上一版本仍可读取。
