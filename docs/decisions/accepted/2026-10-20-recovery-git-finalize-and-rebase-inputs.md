# 决策：Recovery Git 收尾与 rebase 输入边界

状态：accepted

## 问题

历史 tip 可能因 rebase 或删除分支而失去引用，但对象仍存在；仅按 refs 冻结会拒绝正确起点。解决 rebase 冲突的任务本来需要暂存和冲突状态，统一干净检查会误伤。普通收尾异常若统一改写为 runner_crashed，会丢失故障阶段和原因。

## 决定

工具可写前，冻结源 Git 对象库内所有 commit 的 tree，包括不可达 commit；不在 Agent 返回后向活源补认新对象。已识别任务成果祖先检查继续生效。

仅当第一条输入明确涉及 rebase conflict/冲突、副本存在 rebase 状态且 REBASE_HEAD 属于冻结源时，允许该提交修改的 tracked 路径作为输入。其他脏路径仍拒绝，显式 gitStart 不适用例外。内容是否确为历史输入仍由 Agent 调查；文件集合相同不是语义证明。

进行中的 rebase 不剪除历史，保留 refs、原始 tip、待应用对象和元数据，避免接受后无法继续。此时不产生 history_sealed 事件；普通路径继续删除其他引用、reflog 和不可达对象，删除引用使用 --no-deref，避免 origin/HEAD 留下悬空符号引用。

收尾普通异常保留 provider_validation_failed 阶段。持久化错误摘要复用既有脱敏与长度限制；Git seal 的非零退出包含操作名、退出码和脱敏 stderr，不记录完整环境或命令参数。

## 备选方案

**Agent 返回后再向活源查询缺失 HEAD。** 这会把工具执行后出现的新对象补认为历史证据，因此改为事前冻结。

**取消 dirty 检查或封存 rebase HEAD 的祖先。** 前者放行无关答案，后者会破坏续作，因此保留有条件的路径检查并对活动 rebase 延后历史剪裁。

## 影响

不增加持久化字段，不迁移旧记录。冻结大型对象库的扫描成本增加；进行中的 rebase 保留更宽的历史可见性，报告不得宣称已剪除未来历史。后续若要限制待应用提交之外的对象，需要专门的 rebase 续作封存契约。

## 验证

离线真实 Git 测试覆盖符号 remote HEAD、无引用历史 tip、嵌套实验仓库、rebase 输入与无关改动拒绝、封存后继续 rebase，以及普通异常摘要脱敏。它们不证明真实模型的选点语义，也不替代 Windows 实机验证。
