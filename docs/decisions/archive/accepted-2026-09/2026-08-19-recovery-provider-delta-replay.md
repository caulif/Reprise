# Recovery 受控 delta 的 Provider 原子回放

- 日期：2026-08-19
- 状态：accepted

## 决策

受控写工具产生的 direct-write journal 只能由 Host/Provider 回放。回放入口接收 schema 校验过的 journal、Provider-owned staging 和 immutable artifact reader；不接受模型提供的文件正文或任意绝对路径。

Provider 在写入前验证 staging 的基线 digest、每个 postimage artifact 的 owner/hash/size，以及每个相对路径的边界和符号链接祖先。所有操作先作用于 staging 的临时同级副本，完整回放和 tree fingerprint 成功后才替换 staging；artifact 缺失、被篡改、journal 不成对、路径越界或目标不是普通文件均拒绝，并保留原 staging 不变。

rename/delete 的缺失后态只表示删除，不生成伪造正文；staging_shell 仍是 unobserved writer，不能进入此回放合同。该 API 只恢复 Provider-owned 隔离树，不发布到用户源目录，也不代表远端、IDE、browser 或 database 副作用已补偿。

## 实现

- `LocalWorkspaceProvider.applyControlledRecoveryDelta`：隔离副本、基线 digest、路径边界、symlink、artifact 完整性和原子替换。
- `replayControlledRecoveryDeltaBytes`：顺序 journal 配对及字节级 postimage 校验。
- `test/environment.test.ts`：binary、rename、delete 状态回放及篡改失败后原树保持不变。

## 后续约束

模型输入版本、checkpoint 绑定和隐藏真值 fixture 仍需在更高层补齐；本决策不把历史 completed session 的终态字符串升级为恢复真值。
