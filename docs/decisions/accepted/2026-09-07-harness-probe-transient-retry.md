# 决策：Harness 连接探测对瞬时 stopReason 有界重试

状态：accepted

## 问题

开跑前的 `PiModelCaller.validate()` 会向内部模型发一次计费探测。Pi `completeSimple` 的 `maxRetries` 覆盖抛出的传输错误；当上游把失败写成 `stopReason: error`（例如 `Upstream request failed`）时，探测会立刻变成 `HarnessProbeError`。受控 PPT 复跑因此在 Recovery 准备阶段退出，没有进入候选。驱动不得为此再开第二次收费实验。

## 决定

探测在同一个 180 秒预算内，对 `transient_upstream`、`transient_network` 和 `timeout` 的 `stopReason` 失败最多再试两次（合计三次），退避约 200ms 起指数增长，尊重传入 `AbortSignal`。认证、协议和未知错误不重试。抛出异常仍只走 Pi 的 `maxRetries`，不在外层再叠一套。这不是新的实验，也不是驱动层 `/run` 循环。

## 备选方案

**探测失败立刻进错误页。** 瞬时网关失败会被当成终态，真实复跑无法越过准备阶段。

**驱动自动再发 `/run`。** 会得到一份新的总预算，违反单次受控复跑。

**外层再套三次且每次保留 Pi `maxRetries`。** 抛出路径可能打出过多探测请求。

## 影响

瞬时 `stopReason` 不再一次失败就结束 Recovery。持续上游失败仍在三次后进入现有错误页。探测仍计费，最坏三次文本请求。

## 验证

`test/pi-model-caller.test.ts`：前两次 `Upstream request failed`、第三次 `OK` 则 `validate()` 成功且调用三次。持续 `Upstream request failed` 调用三次后拒绝。`invalid api key` 与非瞬时 `connection refused` 只调用一次。去掉外层循环时，成功重试用例失败。
