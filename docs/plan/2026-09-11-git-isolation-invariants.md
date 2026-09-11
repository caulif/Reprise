# Git 隔离不变量：安全、证据、对象库解耦

状态：closed

当前规则见 [Git 隔离不变量](../decisions/accepted/2026-09-11-git-isolation-invariants.md)、[Git sink catalog](../decisions/accepted/2026-09-11-git-sink-catalog.md)、[环境](../architecture/environment.md) §8、[Comparison](../architecture/comparison.md)。本文保留目标推导。

相关：[大仓库按需恢复](./recovery-large-repository-refactor.md)、[稀疏 source mount](../decisions/accepted/2026-09-11-recovery-sparse-source-mount.md)、[Comparison](../architecture/comparison.md)。

## 1. 问题

Git sink 同时承担三件不同的事：

1. **远端安全**：副本里的 `url` / `pushurl` / `insteadOf` 不得把候选 push 送到用户 GitHub。
2. **对照证据**：记录各仓库相对路径上的 initial/final refs，供 Comparison 只读。
3. **对象库播种**：把工作树里的对象搬进 bare sink，让改写后的 origin 看起来像「已有历史的远端」。

当前算法把 3 当成 1 和 2 的前置：`git init --bare` 之后立刻对副本 `fetch`。只要某个嵌套仓库不能当完整 fetch 源（partial clone / promisor / shallow / 损坏 pack），整次 Recovery staging 或 baseline 捕获以异常中止。操作者看到的是落盘前 schema 校验失败，而不是隔离结果。

这与 Host 的其它不变量冲突：隔离不得访问用户 GitHub；对象不完整是源树的事实，不是 Harness 必须补全的缺口；Recovery 启动不要求源树每个嵌套 `.git` 都能当 pack 服务器。

## 2. 目标不变量

按优先级，缺一不可：

**I1 安全先于完整。** 凡是 Harness 拥有的树里、解析后落在树内的 Git 工作树，只要 remote 配置可写，就必须改写到本实验 sink，并挂 `insteadOf`、去掉 `GITHUB_TOKEN` / `GH_TOKEN`。不得因为对象库不完整而跳过改写，把真实 origin 留给候选。

**I2 隔离不得访问用户远端。** 播种与探测一律 `GIT_NO_LAZY_FETCH=1`（及等价的禁用 promisor lazy fetch）。缺 blob 时记 `incomplete_object_store`，禁止为补对象去 GitHub。

**I3 证据来自可观察事实。** `initialRefs` 的权威是工作树 `show-ref`（及 packed-refs），不是 sink 在 fetch 成功之后的内容。sink 未播种时 catalog 仍能列出工作树 refs，并标明 sink 侧对象状态。

**I4 对象库播种是尽力而为。** 仅当完整性分类为 `complete` 时，才从工作树向 sink `fetch`。失败或跳过不得升级为「无法隔离」。`prepareRun` / `beginRecovery` 只在 **I1 无法执行**（无法改写仍指向外网的 remote）时硬失败。

**I5 catalog 是结构化结果，不是 stderr 管道。** 落盘对象必须永远满足 schema。Git 子进程失败进入封闭 `reasonCode`，原文不得充当必填长字段。schema 校验失败只能表示 Host 自己的 bug，不能成为操作者可见的失败原因。

**I6 部分隔离可启动后续阶段。** 顶层 `status: partial` 时 Recovery Agent 仍启动、候选仍可准备；Comparison 必须看见每个仓库的 `objectStore` 与 `isolation` 字段，不得把「origin 在 sink 且缺少历史对象」写成产品能力差异。

## 3. 仓库完整性分类

发现每个工作树后，先分类再行动。分类只读本地 gitdir，不联网。

| 类 | 判定（任一命中） | 播种 | 改写 remote |
|---|---|---|---|
| `complete` | 无 promisor、无 `partialclonefilter`、无 `shallow`、`GIT_NO_LAZY_FETCH=1` 下 `HEAD` 与 advertised refs 的对象可读 | 允许 `fetch` 进 sink | 必须 |
| `incomplete` | `remote.*.promisor`、`partialclonefilter`、`*.promisor` pack、`shallow`、advertised object 缺失 | 禁止以该工作树为 fetch 源 | 必须 |
| `unusable` | gitdir 越界、符号链接 `.git`、不可读、已在 `git-sinks` 内 | 无 sink | 不改写（跳过，记现有 skip reason） |

`incomplete` 仍创建 **receive-only** bare sink：空对象库、可接收后续 push。候选 `git push` 是否成功取决于副本里是否已有要推的对象；Host 不承诺补历史。

## 4. 目标算法

对 Harness 拥有的每一棵树（Recovery staging、published baseline、`prepareRun` 副本）：

```text
discover（树内 .git / gitfile，边界同现行 ADR）
→ 对每个仓库 classify
→ unusable：skipped[]，不创建 sink
→ 其余：ensureBareSink（init --bare + core.longpaths，不 fetch）
→ 从工作树记录 remote URL、show-ref → initialRefs
→ complete 且尚未有 initial sink refs：fetch 播种；失败则 objectStore=seed_failed，sink 仍可用
→ incomplete：objectStore=not_seeded，reasonCode=incomplete_object_store
→ applyRemoteProtection + gitconfig insteadOf（I1）
→ persist catalog（I5；校验失败只允许抛 Host bug）
```

幂等：已记录的 `initialRefs` 不覆盖。重复隔离只补改写与 catalog 状态，不把 `not_seeded` 再升级成硬错误。

失败清理：`beginRecovery` / `prepareRun` / `resolveBaseline` 的 catch 必须删除 **本次 id** 的 sink。不得在 staging 已失败后，再走一条会留下半成品 `baseline-*` sink 且不删除它的路径。

## 5. Catalog 形状（目标）

`schemaVersion` 升到 2。公开字段仍脱敏 URL。每个仓库：

- `isolation`: `rewritten` | `skipped`
- `objectStore`: `seeded` | `not_seeded` | `seed_failed` | `absent`
- `completeness`: `complete` | `incomplete` | `unusable`
- `issues`: `{ code, objectId? }[]`  
  `code` 为封闭枚举，例如 `incomplete_object_store`、`promisor_lazy_fetch_disabled`、`seed_fetch_failed`、`remote_rewrite_failed`、`gitdir_outside`。禁止把 git stderr 写入必填 string 数组。

顶层 `status`：

- `ready`：所有非 skip 仓库 `isolation=rewritten` 且 `objectStore=seeded`
- `partial`：至少一处改写成功，但存在 `not_seeded` / `seed_failed` / skip
- `failed`：存在仍指向外网的可写 remote（I1 破坏），或零仓库改写且存在必须隔离的 remote
- `missing`：无 manifest（finalize 时）

`git-sink-refs.txt` 继续按相对路径列出工作树 initial refs 与 sink final refs；缺播种时 final 可为空，行内标注 `objectStore`。

Comparison 资料索引与 system prompt：只读这些字段；嵌套仓 `not_seeded` 不是候选缺陷。

## 6. 准入与操作者可见性

| 阶段 | `partial` | `failed`（I1） |
|---|---|---|
| `beginRecovery` | 进入 staged，Agent 可见 catalog | 硬失败；reasonCode=`git_remote_unprotected` |
| `resolveBaseline` / `prepareRun` | 允许；`RunManifest.environment.gitSink.status=partial` | 硬失败，删除本次 sink |
| TUI / preflight 诊断 | 显示「Git 对象库不完整，远端已隔离」 | 显示「无法隔离 Git 远端」 |
| Comparison | 按 catalog 解释 origin 与 refs | 不进入对照 |

操作者文案映射封闭 `code`，不展示实验绝对路径、不展示 `GitSinkManifestSchema`。

Recovery / 候选进程环境：在现有 sink `gitconfig` 之外设置 `GIT_NO_LAZY_FETCH=1`，避免改写后的 file origin 再触发对 GitHub 的 promisor 补全。

## 7. 放弃的方案

**把 git stderr 截到 512 字符以通过 schema。** 仍把播种失败当成写盘异常，操作者继续看到错误通道而不是隔离结果。

**捕获 schema 异常后改写 TUI 文案。** 失败语义仍是「无法继续」，Recovery 仍不启动。

**隔离时对 origin 做完整 `git fetch`（联网补 blob）。** 违反凭据与侧效应边界，把用户 GitHub 变成 Harness 依赖。

**发现 incomplete 就跳过该 `.git`、不改写 remote。** 候选仍能 push 到真实 origin。

**删除全部 remote，让 push 失败。** 已在 catalog ADR 中放弃：扭曲「请提交并推送」任务。

**Comparison 自己 `git -C` 读副本。** 已放弃：把 Host 证据变成 Agent 推理。

**始终 `clone --mirror`。** 仍要求完整对象源，Windows 路径更长，且与「不访问用户 GitHub」冲突。

## 8. 模块边界

- `src/environment/git-sink.ts`：分类、播种策略、catalog 写入；不抛业务失败当 schema 失败。
- `src/core/schemas/git-sink.ts`：v2 字段；v1 只读旧实验。
- `LocalWorkspaceProvider`：`beginRecovery` / `resolveBaseline` / `prepareRun` 按 I4/I6 准入；统一 sink 生命周期。
- Recovery 失败路径：preflight 诊断识别 `git_remote_unprotected` vs `incomplete_object_store`；禁止在 staging 失败后再捕获一份会残留的 baseline sink。
- Comparison briefing 与 agent prompt：读 `objectStore` / `issues.code`。
- TUI `operatorErrorMessage`：只映射封闭 code。
- 候选 spawn 环境：`GIT_NO_LAZY_FETCH=1`。

应用层不按 `productId` 分支。完整性是 Git 对象库的属性，与产品 Pack 无关。

## 9. 实施顺序

1. ADR：替代 catalog 中「必须 fetch 才能隔离」；冻结 I1–I6 与 v2 catalog。
2. 分类器与 `GIT_NO_LAZY_FETCH` 探测；反向用例：promisor/`blob:none` 工作树必须得到 `rewritten` + `not_seeded`，且函数返回而非抛 schema。
3. 把 fetch 限制在 `complete`；`incomplete` 走 receive-only sink。
4. Provider 准入与 sink 清理；反向用例：staging 失败不得留下 `baseline-*` 半成品。
5. Comparison 提示词与 briefing；反向用例：catalog 含 `incomplete_object_store` 时对照不得将其判为能力差异。
6. TUI 封闭文案；反向用例：操作者页不得出现 `GitSinkManifestSchema`。
7. `architecture/environment.md`、`comparison.md` 改为描述目标生效后的当前规则；本计划收口。

每步附门禁反向用例。覆盖率阈值不降。

## 10. 验收

- 源树含 GitHub `blob:none` 嵌套仓时：`beginRecovery` 成功 staged；该仓 `isolation=rewritten`、`objectStore=not_seeded`、`issues.code=incomplete_object_store`；用户源目录 remote 不变。
- 对上述 staging 再 `fetch` 播种不得访问网络；探测在 `GIT_NO_LAZY_FETCH=1` 下完成。
- 完整仓路径行为与现行 catalog 测试一致（改写 origin/pushurl、insteadOf、嵌套 hashed 名、越界 skip、token 不进公开 catalog）。
- `writeManifest` 在 Host 单测里若收到非法对象仍抛内部错误；生产路径构造的 catalog 在 `complete`/`incomplete`/`seed_failed` 下均可 `Value.Check`。
- `prepareRun` 仅在 I1 破坏时删除 run 并失败；`partial` 写入 `RunManifest.environment.gitSink.status`。
- 文档：accepted ADR + environment/comparison 与代码同批；`npm run verify:docs`。
