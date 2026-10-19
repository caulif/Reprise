# 决策：统一 Recovery 布局与失败诊断

状态：accepted

## 问题

普通历史调查仍将 Provider 放在 experiment/environment/recovery/run 下，叠加 UUID 与 Git sink 后，Windows Git 会报 `$GIT_DIR too big`，即使启用了 core.longpaths。显式 Git 起点已有 compact-v1，但入口差异使相同隔离操作获得不同的平台可用性。

失败收尾在保存详细诊断前调用 resolveBaseline，复制 source 并再次建立 Git sink；持久性错误会重复发生，阻止原失败诊断完成。用当前 source 的摘要同时填写 source/recovered digest，也不能证明恢复副本存在。

## 决定

所有新建默认 Recovery Provider 统一复用数据目录下 r/experiment-hash/run-hash 的 compact-v1。checkpoint 沿用其所属 Provider，显式注入 Provider 不重定位；旧 scene 继续按原布局加载，不搬迁原始证据。scene 与候选路径校验继续通过实验/run 身份确定性推导，不接受任意磁盘路径。

候选启动准入与副本链接复用同一个 Provider 布局识别函数。新增接受范围只包含当前 experiment 哈希目录中、指定 Candidate run 的 runs/run 路径；兄弟实验、其他 Candidate run、staging 和任意相邻目录仍被拒绝。需要 observations 时仍从原实验事实目录检查，不因工作区缩短而豁免。

Git 调用边界将明确的目录或文件名超限归一为带 cause 的 GitPathLimitError。Recovery 记录 git_path_too_long，设为不可原样重试，TUI 提示使用更短的数据目录。未知 Git 错误继续传播，不按固定的字符数假设所有 Git 操作都支持相同路径长度。紧凑布局不承诺任意长的数据根可用。

失败收尾不再调用 resolveBaseline 或重新检查 source。先保存原失败的生命周期、解释和诊断，再捕获已有验证材料并清理 staging。持久化错误不能跳过清理；持久化与清理审计错误都传播给调用方。清理未完成保留 cleanupFailed 和 staging 供检查。

沿用现有 unsupported baseline 表达未产生可运行副本：无 root、不可 fork、无 accept，不允许启动 Candidate。只复用已观察的 staging source 指纹；未观察的 source digest 和未认证的 recovered digest 为空。warning 的新写入为 fallback: none，不把历史 current_state 事件重解释成新语义。

## 备选方案

**只提高超时、开启 core.longpaths 或原位置重试。** 路径限制是确定性的，不能通过等待或重复请求消除。

**迁移所有历史实验或引入新的全局临时目录。** 本次已有 compact-v1 可复用；迁移增加旧证据与资源生命周期风险，不作为修复前提。

## 影响

新建普通调查的工作目录改变，scene 继续使用现有 compact-v1 字段；旧记录兼容读取。失败结果不再提供当前 source 的可运行副本，不改变成功或 blocked preview 的发布方式。持久化本身不可用时仍向调用方报错，不承诺一定生成完整诊断。

## 验证

离线回归覆盖普通入口、真实 UUID 与本地 Git、紧凑 scene 重载、候选副本与跨实验路径拒绝；Windows 用真实 Git 验证超长 sink 的结构化失败。持久 staging 错误不得触发 fallback 复制或 source 重查，必须保留失败诊断并阻止 Candidate。诊断写入故障仍需释放已有 staging，不能将收尾遗漏报告为成功。

这些用例验证宿主流程与本机 Git，不认证真实模型或 Runtime 的任务完成能力。
