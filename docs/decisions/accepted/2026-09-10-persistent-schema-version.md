# 决策：持久化对象当前写入 schemaVersion 1

状态：accepted

## 问题

CandidateLaunchContext、Runtime Journal payload、UserVisibleTurn 和事件信封若缺少版本或未知版本被当成功读入，损坏日志会静默降级。

## 决定

上述对象写出 `schemaVersion` 1。Journal 读取 `EventEnvelope.schemaVersion` 不是当前版本时以 `unsupported_schema` 失败。

## 备选方案

**缺版本时按当前 schema 猜测。** 无法区分截断与新格式。

## 影响

打开未知版本 journal 必须失败并保留原文件。

## 验证

`test/core/store.test.ts` 打开未知 `schemaVersion` 的 journal 必须失败。

