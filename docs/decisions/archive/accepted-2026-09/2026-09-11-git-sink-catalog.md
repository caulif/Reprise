# 决策：Git sink catalog、发现边界与保留窗口

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-11

## 问题

候选可在隔离副本里 `git push`。仅改 origin 不够：`.git` 文件、worktree、越界 gitdir、部分失败重试、初始/最终 refs 和 Comparison 读法都没有 Host 级契约。Comparison 若假设 `main` 或把用户 GitHub 当远端，会误判任务结果。

## 决定

- Host 在 Harness 拥有的树内递归发现 `.git` 目录与 `gitdir:` 文件。解析后的工作树与 gitdir 必须落在该树内；符号链接 `.git`、越界 gitdir、不可读 gitdir 跳过并记原因。不把 `git-sinks` 再发现为仓库。
- 每个 run（及 Recovery/baseline 对应 id）使用 `environment/git-sinks/{id}/repos/` 下的独立 bare sink；根仓 `_root.git`，其余为相对路径 SHA-256 前 12 位。`git init --bare` 后从副本 `fetch` refs，不 clone、不访问用户 GitHub。`core.longpaths` 开启。重复执行幂等：已有 `initialRefs` 不覆盖。
- 改写每个 remote 的 `url` 与全部 `pushurl`；无 remote 时创建 origin。已记录 URL 同步改写 `.gitmodules` 与 `submodule.*.url`。run 级 `gitconfig` 的 `insteadOf`（含 GitHub URL 别名）为第二道兜底；候选环境去掉 `GITHUB_TOKEN`/`GH_TOKEN`。Git sink 不做通用网络隔离，也不伪造 GitHub review/CI/protection。
- Host 写入经 schema 校验的 `git-sink-manifest.json` 与 `git-sink-refs.txt`（按仓库相对路径列出 initial/final refs 与变化）。公开 catalog 只含脱敏 URL。Comparison 只读 catalog，不写 sink，不假设分支名。候选结束后 `sealCandidateSnapshot` 生成最终 catalog；sink 保留到 Comparison 可用，随 experiment 目录删除统一清理。`prepareRun` 失败或 Recovery discard 时删除对应 sink。

区间内公开正文拼接遵守 [按 settlement 取视图](./2026-09-09-controller-permissions-view-prompt.md)。

## 备选方案

**删除 remote 让 push 失败。** 扭曲「请提交并推送」任务。

**Comparison 直接 `git -C` 读副本。** 把 Host 证据变成 Agent 推理，且仍可能碰到已改写的 origin。

**insteadOf 拦截全部 github.com。** 超出 Git sink 职责，变成未声明的网络策略。

## 影响

[环境](../../../architecture/recovery.md)、[Comparison](../../../architecture/evidence-and-comparison.md)、[按 settlement 取视图](./2026-09-09-controller-permissions-view-prompt.md)。

未知且未记录过的 GitHub URL 仍可能指向真实远端。

「必须从副本 `fetch` 才能隔离」、以及用 git 子进程原文充当 catalog 错误字段，由 [Git 隔离不变量](../../accepted/2026-09-11-git-isolation-invariants.md) 替代。发现边界、sink 命名、remote 改写、`insteadOf`、token 剥离、越界 skip、Comparison 只读 catalog、sink 保留窗口仍以本文为准。

## 验证

- `test/core/git-sink.test.ts`：嵌套/`caulif`、`.git` 文件、submodule、origin 与 pushurl、新 branch、GitHub URL `insteadOf`、越界 gitdir、幂等 initial refs、失败 prepare 删除 sink、catalog schema、token 不出现在公开 catalog。
- Comparison 资料索引与 system prompt 指向 `briefing/candidate/git-sink-manifest.json` 与 `briefing/candidate/git-sink-refs.txt`；按仓库相对路径读 initial/final refs，不要求 `main`。
