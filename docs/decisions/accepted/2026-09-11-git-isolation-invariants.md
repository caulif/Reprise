# 决策：Git 隔离把远端安全、对照证据和对象库播种分开

状态：accepted
日期：2026-09-11

## 问题

[Git sink catalog](../archive/accepted-2026-09/2026-09-11-git-sink-catalog.md) 把「从副本 `fetch` 进 bare sink」当成隔离成功的前置。嵌套 partial clone / promisor / shallow 不能当完整 fetch 源时，Recovery 与 baseline 捕获在写 catalog 前中止；git stderr 又撑破 schema。对象不完整是源树事实，不是必须补全的 GitHub 历史。

## 决定

隔离遵守六条不变量：

- **I1** 树内可写 remote 必须改写到本实验 sink，并挂 `insteadOf`、去掉 `GITHUB_TOKEN` / `GH_TOKEN`。对象库不完整不能跳过改写。
- **I2** 播种与探测使用 `GIT_NO_LAZY_FETCH=1`，不为补对象访问用户远端。
- **I3** `initialRefs` 来自工作树 `show-ref`，不是 sink fetch 是否成功。
- **I4** 仅 `complete` 仓库才从工作树向 sink `fetch`。`incomplete` 使用 receive-only sink。`prepareRun` / `beginRecovery` 只在 I1 无法执行时硬失败（`git_remote_unprotected`）。
- **I5** catalog `schemaVersion` 为 2：每仓 `isolation`、`objectStore`、`completeness`、`issues.code` 封闭枚举。Git stderr 不进必填字段。schema 校验失败只表示 Host bug。
- **I6** 顶层 `status: partial` 时 Recovery 与候选准备继续。Comparison 不得把 `not_seeded` / `incomplete_object_store` 写成产品能力差异。

发现边界、hashed sink 名、remote 改写、`insteadOf`、token 剥离、越界 skip、sink 生命周期仍遵守 catalog ADR。本决定替代其中「必须 `fetch` 才能隔离」及「用 git 原文充当 catalog 错误」的条款。

候选与隔离进程环境设置 `GIT_NO_LAZY_FETCH=1`。`resolveBaseline` / `prepareRun` / `beginRecovery` 失败时删除**本次 id** 的 sink。

## 备选方案

**截断 git stderr 以通过 schema。** 播种失败仍表现为写盘异常。

**隔离时联网补 blob。** 把用户 GitHub 变成 Harness 依赖。

**incomplete 就跳过 `.git`、不改写 remote。** 候选仍能 push 到真实 origin。

**删除全部 remote。** catalog ADR 已放弃。

## 影响

[环境](../../architecture/environment.md)、[Comparison](../../architecture/comparison.md)、[Git sink catalog](../archive/accepted-2026-09/2026-09-11-git-sink-catalog.md)（发现、改写、保留窗口仍有效）。

## 验证

- `test/core/git-sink.test.ts`：`blob:none`/promisor 得到 `rewritten` + `not_seeded` + `incomplete_object_store`，且 `isolateGitTopology` 返回；完整仓路径与 catalog 测试一致；非法 manifest 仍使 `writeManifest` 抛内部错误；I1 失败删除本次 sink，不留 `baseline-*` 半成品。
- Comparison system prompt 与 briefing 写明 `objectStore` / `issues.code` 不是能力差异。
- TUI `operatorErrorMessage` 映射封闭 code，操作者页不含 `GitSinkManifestSchema`。
