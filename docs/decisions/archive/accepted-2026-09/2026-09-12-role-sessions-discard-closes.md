# 决策：已创建的角色 Session 失败后必须关闭

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-12

## 问题

从 `RoleSessions` Map 删除失败 key 而不 `close()`，会留下 Provider 连接或子进程。创建尚未成功的 Promise 不能调用 `close()`。

## 决定

创建失败时从 Map 移除该 in-flight Promise，不调用 `close()`。已成功创建的 Session 在请求失败后由 Controller/Comparison 调用 `discard()`，语义等于 `release()`：等待创建完成、`close()`、再移除。`close()` 失败向上抛出。Recovery 请求失败不 discard，以便同一 Session 续跑剩余轮次；工作区损坏时 Host 再 `releasePreparation`。

## 备选方案

**失败一律 drop 不 close。** 资源泄漏。

**失败一律 close。** 创建失败的 Promise 没有 Session 对象。

## 影响

Comparison/Controller 失败后同一 attempt/runId 下次 `get` 会新建 Session。Recovery 信封失败仍复用 Session。

## 验证

`test/application/role-sessions.test.ts`：`discard` 后 `close` 被调用且 key 消失；`release` 的 close 失败可见。反向：恢复 `drop()` 只 `delete` 时架构测试与 discard 断言失败。
