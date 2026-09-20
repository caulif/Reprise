# 决策：对照 headless 截图失败重试

状态：accepted

## 问题

Comparison 通过本机 headless 浏览器生成视觉证据。浏览器可能独立于 Comparison 模型会话异常退出或超时；如果立即把它当作终态取消，会丢弃本来可以完成的对照。

## 决定

headless 截图边界对浏览器进程失败最多重试一次。找不到浏览器不重试；已中止的 `AbortSignal` 在截图前停止且永不重试；操作者主动取消仍是终态取消。

重试只发生在截图操作内，不重放 Comparison Agent 会话或候选运行；每次尝试前删除旧的目标图片。

## 备选方案

**整个 Comparison attempt 重试。** 会重复模型调用和报告写入，无法区分用户取消，成本和副作用更大。

**不重试。** 实现简单，但一次可恢复的浏览器退出会直接让对照失败。

## 影响

- `comparison-briefing`、`comparison-openable-media` 和 `headless-screenshot` 需要传递取消信号。
- 重试不会改变 CandidateRun 状态，也不会启动第二个 Comparison session。

## 验证

- `test/application/headless-screenshot.test.ts`：第一次浏览器失败、第二次成功时只重试一次；`options.signal` 在捕获中可见且中止后不重试。
- `test/application/comparison-openable-media.test.ts`：已取消的 Comparison 不启动截图；生产路径传入 `{ signal }` 而非裸 `AbortSignal`。
- `test/application/comparison-briefing-abort.test.ts`：briefing/openable-media 的 `AbortError` 映射为 `cancelled`，不是 `publication_failed`。
- `npm run build`、相关测试和 `npm run check` 已执行；check 中既有的 Windows symlink、历史 baseline fixture 和 knip 失败与本改动无关。
