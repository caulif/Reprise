# 决策：发版 PR 驱动 npm 与 GitHub Release

状态：accepted

## 问题

Reprise 是单 npm 包，首次 v0.1.0 手动发布。日常合并不代表发布，人工维护两处版本、更新记录和包附件容易产生差异。目标是维护者正常审核功能 PR，准备发版时只需再审核并合并一个发版 PR。

## 决定

采用 Release Please manifest 模式，基于 Conventional Commits 生成发版 PR，统一更新 Node 包版本、lockfile、manifest 及 docs/CHANGELOG.md。从现有 0.1.0 引导；稳定版使用 v 前缀，无组件名前缀；0.x 破坏性变化提升 minor，功能提升 minor，修复提升 patch。

使用内置 GITHUB_TOKEN 创建发版 PR 和 Release 草稿，不引入长期 PAT。机器人 PR 由同一工作流显式 dispatch 现有 check 工作流到它的分支，因为 GITHUB_TOKEN 创建的 PR 不会自动触发普通 PR CI。dispatch 不能降低原 full/static 门禁。

发版 PR 合并后先创建草稿和固定 tag，显式 dispatch tag 工作流，使 GitHub 运行身份与 provenance 的提交等于打包源码。完整检查并打包后，通过 GitHub-hosted runner 的 npm OIDC Trusted Publishing 发布。npm 版本可读、完整性及独立安装通过后，附同一 tarball 并公开 GitHub Release。发布权限仅在 publish 作业开放 id-token/write 和 contents/write，且绑定只允许 v* tag 的 npm environment；不在普通 PR 上运行发布。

两平台没有原子事务。恢复入口按原 tag 绑定提交；版本、manifest、lockfile 和 tarball 必须一致。只有 registry 的 404 表示版本不存在，其余错误拒绝发布。已存在版本只接受完全相同的完整性，附件只复用相同内容。重试不得覆盖 npm 版本、移动 tag、覆盖附件或回退 latest。

新增 verify:release 门禁，纳入 check/full/static；自动反向用例证明错误身份、不一致版本或完整性以及 registry 认证/限流/服务错误不能通过。保留已有测试、覆盖率与真实调用 opt-in 边界。

## 备选方案

**每次 main 合并直接发包。** 不保留维护者决定发布时点的审核，不采用。

**Changesets。** 适合多包和贡献者逐项描述版本影响；当前单包及已有规范化 squash 提交无需增加每个 PR 的 changeset 文件。

**保存 npm Token 或 GitHub PAT。** 增加长期凭据管理，不采用；明确 dispatch CI 处理默认 token 事件限制。

**先公开 GitHub Release 再发 npm。** npm 失败时公开页面会误导使用者，采用草稿直到同步验证完成。

## 影响

一次性开启 GitHub 机器人创建 PR 权限，并由维护者配置 npm Trusted Publisher。未启用时不能宣称自动发布已验收。CLI 与用户数据格式不变。公开启用和故障恢复以 [发布指南](../../releases.md) 为准。

## 验证

执行 npm run check、发布反向用例与 workflow 语法检查；实际 npm OIDC 发布必须等信任关系配置完成后验收。不在本地校验中调用真实模型或发布测试版本。
