# 版本维护与发布

## 日常维护

功能 PR 正常审核并 squash 合并到 main。最终提交标题使用 Conventional Commits：`fix:` 表示修复，`feat:` 表示新功能；不兼容变化使用 `!` 或提交正文中的 `BREAKING CHANGE:`，并写清迁移、兼容性和回滚方法。

Release Please 在 main 更新后创建或更新一个发版 PR，统一维护 package.json、package-lock.json、版本 manifest 和 CHANGELOG。准备发布时，审核版本和面向用户的说明，等待该 PR 的 CI 成功，再合并一次即可。不需要手动运行 npm publish 或再次创建同版本 Release。

当前策略：修复提升 patch、新功能提升 minor；0.x 阶段不兼容变化提升 minor，1.x 起提升 major。安装流程和预览图等文档变更可随下一次发布汇总，不要求每个文档 PR 单独发版。需要强制指定版本时，按 [Release Please 的 Release-As 机制](https://github.com/googleapis/release-please#how-do-i-change-the-version-number)在提交正文指定版本，再审核发版 PR。当前自动发布只接收稳定版，不发布 beta/next。

不要手工提升版本或移动已发布 tag。初始 manifest 从现有 v0.1.0 开始，后续版本由机器人推进；无需重发 0.1.0。

## 首次启用

工作流文件为 [release.yml](../.github/workflows/release.yml)。合入后需要完成以下一次性设置：

1. GitHub 仓库 Settings → Actions → General → Workflow permissions，允许 GitHub Actions 创建 Pull Request。工作流使用临时 GITHUB_TOKEN，不需要保存 GitHub PAT。GitHub 的设置同时允许 Actions 审核 PR，但本流程不自动审核或合并发版 PR。
2. 创建 GitHub Environment `npm`，deployment branch policy 选择 selected，并只允许 tag 模式 `v*`。如不希望发布时再人工批准，不增加 required reviewers；审批点保留在发版 PR。
3. 在 npm 的 @caulif/reprise 包设置中新增 GitHub Actions Trusted Publisher：owner `caulif`、repository `Reprise`、workflow filename `release.yml`、environment `npm`。环境名称及文件名须完全一致，不填写工作流显示名称。若页面提供 Allowed actions，勾选 `Allow npm publish`（本流程直接发布），保持 `Allow npm dist-tag` 未勾选；仅有默认的 staged publishing 权限不足以运行本流程。
4. 不添加 NPM_TOKEN，也不为了自动化关闭 npm 账号 2FA。OIDC 使用 GitHub-hosted Ubuntu runner；当前固定 Node 24.11.1 和 npm 11.6.2。
5. Actions → release → Run workflow，分支选 main，tag 留空，初始化或刷新发版 PR。流程合入后的 main push 通常也会自动执行。

配置 Trusted Publisher 是对 CI 的发布授权，应由包维护者在 npm 设置中完成。若未配置，发版 PR 仍可生成，但实际 npm 发布会失败，GitHub Release 保留草稿。

## 一次发版发生什么

1. 发版 PR 合并后，Release Please 创建对应 tag 和 GitHub Release 草稿。tag 固定到发版提交；草稿不是已同步发布成功。
2. 控制流程显式 dispatch 同一个工作流到固定 tag，让 GitHub 的运行身份、OIDC provenance 与源码提交一致。Windows runner 从该提交运行 npm ci 和 check:full，检查版本一致性、包清单、依赖及秘密边界，生成唯一 tarball。检查不启动真实模型。
3. Ubuntu runner 通过 OIDC 发布该 tarball。manifest、package、lockfile、tag、tarball 版本及提交身份必须一致。
4. 从公共 npm registry 确认完整性，并在独立目录按包名安装，检查 CLI 的 --version 和 --help；这不是实际 Runtime 验收。
5. 将相同 tarball 附到 GitHub Release，最后公开草稿。两处发布不是原子事务，失败状态必须由 workflow 判断，不能只看 tag 是否存在。

机器人创建的 PR 不会通过默认 GITHUB_TOKEN 自动触发普通 PR 事件，因此 release 工作流显式 dispatch [check.yml](../.github/workflows/check.yml) 到该 PR 的分支；该运行采用完整 CI。不要为此增加长期 PAT 或跳过检查。

PR 维护和 tag 发布使用不同 concurrency group，避免普通 main 更新取消待发布任务。一次发布完成后再合并下一次发版 PR；GitHub 同一组只保留一个等待运行，短时间合并多次发版可能需要手动补跑被替换的等待版本。

## 失败与重试

先查看失败阶段。对已创建的 release，使用 Actions → release → Run workflow，选择 main 并填写原 tag（例如 v0.1.1），也可以在原运行中重跑失败作业。重试总是读取原 tag 对应的发版提交，不使用最新 main 代替。

- npm 尚无该版本：检查失败原因后按相同身份重新发布。
- npm 已有该版本且完整性相同：跳过 publish，继续安装验证和 GitHub Release 补齐。
- npm 已有该版本但完整性不同：拒绝覆盖；调查原发布包，必要时以新版本修复。
- registry 认证、限流、网络或服务错误：拒绝当作“版本不存在”，不盲目再次 publish。
- GitHub 已有同名附件：下载并比较完整性，相同则复用，不同则失败；不自动覆盖附件。
- npm latest 已更新到更高版本：不将 latest 回退到旧版本，也不将旧版 GitHub Release 标为 latest。

若 OIDC 已认证但 publish 长时间等待，先检查 npm 安全扫描或分发延迟，不改用同版本覆盖发布。

## 验证与回滚

[verify-release.mjs](../scripts/verify-release.mjs) 检查版本与发布配置，并执行版本、提交、完整性不一致、registry 非 404 错误等反向用例。它接入原有 check/static 门禁，不替代其他测试或覆盖率。发布脚本只处理发布元数据，不读取产品模型密钥或 Codex 凭据。

发布问题优先以新版本修复；必要时由维护者弃用故障 npm 版本。不可重写已发布的 npm 版本、移动历史 tag 或原地改写用户数据。禁用 release 工作流只暂停自动发布，不影响已发布版本。流程取舍见 [自动发版决策](./decisions/accepted/2026-10-20-automated-releases.md)。
