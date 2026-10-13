# 决策：单任务 Recovery 会话与外置 Host 产物

状态：accepted

## 问题

强制三轮和项目内报告与任务树验证冲突；mtime 无法可靠判断答案污染。需在保留 source 保护、显式 Git 起点和旧 scene 兼容的条件下简化恢复。

## 决定

Recovery 采用一个持续 Session 的单次任务交付，不固定三阶段模型结束。Host 保存报告、日志与 home，不要求模型在待封存项目写内部材料；新 marker 使用可选 external-v1 标志，旧 scene 不迁移。

Recovery 按角色 opt-in 增加通用 apply_patch/view_image，复用既有静态解析、受控写入和原生图片实现。补丁当前支持 Add/Update/Delete 和唯一上下文，Move 与 context-free insertion 明确不支持；不假装支持 freeform wire format。独立 observations 文件读可和项目后台进程并行；项目冲突写入仍互斥。观察材料保持文件工具降级路径，不把命令文本过滤声称为真正只读 shell sandbox。

普通 historicalCommit 仅作线索。工具修改前冻结 source 的 Git 映射、任务 commit receipt 与指纹；metadata 起点 commit 不当作成果。Host 验证所选 HEAD/tree，按内容而非 mtime 检查 dirty 文件，并在模型选择后清理隔离树未来历史。原 source dirty 同字节文件保留，但其归属不能仅由内容一致性证明，必须保留调查与独立审计边界。显式 gitStart 不受这项推断策略影响。

总预算 30 分钟，无工作请求数额度；相同失败且文件状态不变停止机械反馈循环。模型请求、工具、压缩、usage 与 Host artifact 保留审计。

## 备选方案

**保留三轮和项目内报告。** 维持原兼容，但额外协议与文件污染继续存在，未采用。

**移植全部 Codex 宿主。** 工具及沙箱体量过大，且当前 Recovery 无需 PTY、插件或浏览器，未采用。

## 影响

原来的 notes/report 与任务树脏文件检查互相冲突，并导致恢复完毕后反复处理内部材料。通用工具和一个目标减少额外协议，但不能代替原任务边界判断、冻结依据或独立真实测试。

受管进程继续 invocation-owned：单次 request 内多个模型 turn 共享句柄，最终 decision、取消或关闭前必须排空。没有复制 Codex 整套宿主、PTY、审批或容器。任意 shell 仍不构成全局外部副作用隔离。

Git 封存只处理普通独立 `.git` 目录，拒绝 gitdir、commondir、alternate、链接和模型预置的禁用 hook/config 路径；清理继承的 Git 环境并逐次禁用 hook、fsmonitor 与全局配置。全局配置指向 Git 支持的 `/dev/null`，避免 Windows 在解析 longpaths 配置之前打开深工作区中的占位路径而失败；不读取或修改用户全局配置。Windows 深暂存路径逐次启用 longpaths。封存失败不自动再次执行。

## 验证

回归覆盖单次任务交付、结构化修复、旧事件读取、外置产物与用户同名文件、补丁预检/CRLF/取消/权限、图片 native blocks/allowBinary、历史读取与项目写者并行、固定依据与回拨 mtime 逆例。真实实验独立检查源指纹、HEAD、答案残留、封存重载和 Candidate 副本准备；不把这项准备称为完整 Candidate 任务通过。

### 证据可读性与责任分界

冻结观察保留隐私处理后的完整正文，原有 JSON envelope/ref/path 不变，`truncated` 为 false；旧 excerpt 文件仍可读，不伪造已丢失尾部。`timeline/INDEX.tsv` 提供按冻结 transcript 顺序排列的精确编号文本路径，包含规范化消息与工具命令/结果，并指向原 transcript JSON。`index-pages/` 将既有 catalog 按 100 条分页，完整 INDEX.tsv 保留。这里只投影已有历史，不替 Agent 选择语义起点。

read 的正文显式区分 not_found、not_readable、empty_file、end_of_file 与 truncated，截断时在正文交付 nextCursor；不能依赖 Provider 不一定发送的 details。只有已知不存在/访问拒绝可作为可纠正读取反馈；未知 I/O、安全边界及审计故障保持致命，审计失败不重试或降级。完整观察只来自已冻结并处理隐私的 TaskCase，工具返回继续通过既有审计事件复原模型输入。

Agent 选择并解释起点、恢复工作树；Host 统一封存 refs/reflogs/未来不可达对象，写入 recovery.history_sealed。外置报告保留 Agent 封存前判断，另列 Host 封存后机械检查；不静默重写模型事实，不把机械校验声称为历史语义证明。ready 仅表示合理起点允许 Candidate 开始；零条额外 checkedPaths/commandChecks 明确表示未做额外执行验证，不表示原任务完整可执行。
