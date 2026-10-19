# 决策：Recovery 恢复输入边界，长命令由宿主管理

状态：accepted

后继：[统一 Recovery 布局与失败诊断](2026-10-19-recovery-layout-and-failure-evidence.md) 将紧凑目录扩展到新建普通历史调查，并取消失败收尾的基线物化；其余决定继续有效。

## 问题

历史 Git 任务在 Recovery 内安装工具链与全量构建，尚未恢复正确 HEAD 就耗尽总时间。同步 shell 的 60 秒生命期被误当成等待间隔；致命工具失败只记录、不及时停止模型，又进一步消耗时间。单纯增加阶段、加长所有超时或追加业务提示不能修复这些契约断点。

## 决定

Recovery 默认只恢复任务前源码与必要输入。依赖与构建由候选实际验证需求触发；用户明确要求恢复运行环境时仍按目标处理。`ready` 不再暗示已完整构建，结果必须区分起点验证与实际执行过的检查。

新增调用方显式 `gitStart` 输入，包含完整 commit SHA 和必填的文件路径/hash 清单。历史会话文本及 `historicalCommit` 不具有该授权。契约由 core schema 校验；请求及恢复 commit、输入 hash、指纹和耗时写入事件。它不是 TaskCase 的自动推断字段，也不改变冻结历史任务内容。

Provider 只在自有 staging 内操作：建立独立仓库，获取指定提交及祖先，复制哈希匹配的清单输入，重新建立 Git sink。不会保留未来任务提交或未列出的未跟踪成果；不会 reset/clean 用户源仓库。Windows 路径别名、Git/Harness 元数据、重复输入和越界路径拒绝。submodule、symlink、LFS filter、缺少 commit 或 sparse staging 尚不支持该快速路径，不能静默接受。未知起点继续使用现有 Agent 调查。

确定性恢复可从 staged 直接进入 validated，随后沿用机械验证、起点检查和接受流程。结果中 provider-owned session 标识表示宿主结果，不生成 Agent 模型调用事件；诊断不宣称启动过 Recovery Agent。现有调查路径、checkpoint 和旧事件读取保持有效。

Windows Git 的 `$GIT_DIR too big` 不受 `core.longpaths` 或短 cwd 加相对路径消除。显式 Git 起点的新默认 Provider 使用数据根下 `r/<experiment SHA-256 前32位>/<run SHA-256 前32位>`，避免重复 UUID 与描述性目录累积。scene 新增可选 `recoveryProviderLayout: compact-v1`；加载时按实验和原 Recovery run ID 确定性重建，不信任任意外部路径。候选副本路径校验识别该实验专属目录，拒绝跨实验路径。旧 scene、调查路径及调用方注入 Provider 不迁移；任意长数据根仍不在保证范围。

参考 [Codex 工具定义](https://github.com/openai/codex/blob/ddb33e34b278ca1b7d16d1e68f8ad363a2042f2e/codex-rs/core/src/tools/handlers/shell_spec.rs) 的 `exec_command` / `write_stdin` 语义，补充受管进程端口与 Recovery 工具。默认管道，等待结束返回句柄而非终止命令；同一 invocation 内读取新增输出或发送输入，明确取消等待进程收尾。保留旧 `shell_exec` 兼容入口，不将 Codex 的全部工具、审批参数、PTY 默认值或 freeform patch schema 原样复制到不同 Provider。

句柄绑定 Session、invocation 与工作区，不能跨运行使用；宿主重启后不凭旧 PID 恢复权限。后台命令存活期间阻止冲突文件/命令操作，独立只读工具可并行。invocation 成功或让出之前必须排空受管进程；尚未完成的命令不能算作成功交付，终止不确定时不得封存。

命令非零退出是模型可见的真实结果；编辑未匹配、句柄失效和 workspace busy 是明确的前置条件拒绝。未知工具、文件系统、审计与持久化失败仍致命，并立即取消 invocation。新增工具输入/输出通过既有审计记录，输出分页与截断必须可识别，不把截断当完整证据。进程日志位于宿主管理的暂存目录，不能包含未脱敏凭据。

审查修订（2026-10-13）：输出不得先分页后逐页脱敏。每条 pipe 独立增量解码 UTF-8，解码文本合流后保留潜在凭据前缀及未结束值，完整记录复用共享脱敏器，再进入分页、模型、事件及日志。普通提示无需等待换行；待定敏感记录超过 64 Ki 字符时省略并标记截断，结束时未闭合敏感记录省略。这是有界输出流状态，不是新的 Agent 阶段。参数和完成审计同样复用共享脱敏器，避免 JSON 凭据或 URL userinfo 绕过旧正则。日志失败必须在取消清理结束后重新抛出，不能因进程先结束而变为成功取消。

## 备选方案

**默认安装和完整构建，但把时间再放宽。** 未减少任务无关工作，也无法纠正起点选择错误，拒绝作为默认。

**从任意历史 commit 自动 reset，再 git clean。** 历史 commit 不一定是起点，会丢失必要未跟踪输入；原仓库或共享元数据写入风险不可接受。

**完全复制 Codex 工具集和执行默认值。** Reprise 多模型工具协议、Windows 支持、审计与 workspace 边界不同；复制名称无法提供对应生命期保障。

**把所有 shell 标为并行。** 模型声明只读不足以证明任意命令安全；返回句柄之后仍有后台写入，因此必须在进程生命期内协调资源。

**遇到错误一律继续。** 会把审计失效或未知写入结果伪装成成功，只允许已知、无副作用的前置条件拒绝继续。

## 影响

新能力以显式输入和工具选项接入。旧调用方无需新增 gitStart；旧工具可继续使用，旧事件仍可读。新 lifecycle operation 与事件由新版读取器解释，回滚旧版本时不要继续旧程序不认识的新运行；无破坏性历史数据迁移。

没有增加新的 Agent 阶段、请求次数额度、容器构建或全局依赖安装。第一版仍沿用 source 复制与工作区预算；大型仓库、LFS/子模块、依赖缓存与安装并发优化后置，以实际测量决定。

宿主提供的本机 shell 仍不是容器沙箱，不宣称可以撤销外部副作用；原源保护、凭据边界、候选状态机与发布验证继续适用。

## 验证

离线 Git fixture 覆盖无需模型接受、完整 commit、必要中文/空格输入、未来答案对象排除、源不变、输入 hash 改变拒绝、缺失对象与 submodule 拒绝及路径别名。受管进程 fixture 验证等待与生命期分离、增量输出、非零退出、跨 owner 拒绝、后台操作冲突和结束前收尾；Provider/Pi fixture 验证致命错误立即停止而编辑拒绝仍可修正。

代码验证先 build 再运行 dist 测试，并执行 `npm run check`；fixture 不替代真实模型或真实目标任务验收。真实模型运行继续显式 opt-in，成本和冷/暖缓存准备须分别记录。

workflow 回归使用真实 UUID 与默认临时目录，验证完整 Git 恢复、compact scene 重载及跨实验副本路径拒绝；既有 scene 重载回归同时保留，不能以缩短 fixture 路径掩盖默认入口的问题。

输出回归逐一切分凭据格式，检查跨 poll、跨 pipe、分页预算、UTF-8 半字符及内存截断边界；端到端工具 fixture 检查模型结果、事件与磁盘日志中均不出现合成密钥。参数审计另覆盖 JSON 与带 userinfo 的 HTTPS URL。
