# 决策：版本化冻结任务身份与统一读取

状态：accepted

## 问题

原 TaskCase 的 ID 与 contentHash 只描述来源字节。冻结起点、授权或解释内容变化仍命中旧路径；此前的保全补丁能拒绝替换，但不能让不同任务版本共存。多个读端只检查部分字段或仅使用类型断言，也不能证明读取的任务和附件属于同一冻结内容。

## 决定

新冻结为 v2，旧 v1 原样读取，未来未知版本拒绝。TaskCaseSchema 是明确 v1/v2 联合结构；v1 不携带新身份，v2 必须有 task-case-v2 identity 和保留文件清单。统一验证分成 core 的纯 schema/owner/digest 检查与 Product 共享文件读端，应用和 CLI 复用，不跨层反向 import。

v2 规范化输入显式包含 schemaVersion、source 的 productId/sessionId、evidenceLevel、initialInput、execution、完整 transcript/historicalEvents/taskContext、baseline、来源 Runtime 证据、provenance 的 packVersion/sourceHash、有效 privacy 与 freezeIdentity（算法和文件清单）。对象键按字典序，数组保留原顺序；文件清单由创建者按相对路径排序。JSON 的省略 undefined 语义在规范化之前处理。

排除 provenance.importedAt、source.sourcePath、可移动 casesRoot、自身 caseId/contentHash 和 case-owned artifactRefs 的 owner 回指；不删除任务正文或 taskContext 中有语义的路径。hash 为完整 SHA-256；ID 用 case-v2- 加 hash 的 128 位前缀，以控制 Windows 嵌套路径长度。内部引用先校验原 owner，再补新 owner；同路径仍比较完整 digest，不能凭前缀认定相同。

文件清单绑定实际保留的 raw、额外文件、artifact manifest 及 artifact 的相对路径、byteLength 与字节 SHA-256。提取算法版本在 manifest 内绑定，Pack 版本在任务中绑定。发布输入必须匹配完整清单，私有目录不允许其它未绑定文件。持久化 reader 核验全部文件并校验 artifact manifest 引用与文件清单；旧 v1 没有这些保证，不追认它的 hash 为 v2 完整内容认证。digest 认证内容关系，不认证历史语义、来源真实性或模型判断。

目录发布使用同身份独占 wx 租约，在取得租约后检查目标、创建私有 staging、复核 staging 文件、写完整标记并沿用 Windows rename 重试。竞争方有界等待；旧锁不自动判断陈旧或删除。锁有 nonce 和文件身份，释放不删除被替换的他人锁。文件 hard link 原语不套用于目录。

外部 TaskCase 文件可以无完整标记读取，仍校验 v2 的绑定文件；它可以与其它外部文件同根，但重新持久化只复制绑定清单，不认领外部根的其它文件。已校验对象的来源根通过 WeakMap receipt 传递给持久化入口，避免把本机 locator 存进身份或模型日志；复制后再次核验 staging 防止读后改变来源。未持有 receipt 的对象若需要复制绑定文件则拒绝，调用者须重新读取正确来源。私有场景/比较加载要求完整标记。case JSON、root、私有 casesRoot 和清单内部文件不接受符号链接/junction；显式配置 dataDir 的上级仍是操作者选择的 locator，不承诺阻止同权限恶意进程在检查间替换目录。

## 备选方案

**维持来源 ID 并覆盖/改起点**：会改变旧实验的任务；止损拒绝虽能保全，却不能支持多版本，因此只保留旧 v1 的兼容读语义。

**把 importedAt 或绝对目录放入 hash**：能减少碰撞，却破坏重试幂等和整体目录移动，且身份不能表达实际内容关系。

**目录使用 hard link 或仅进程内锁**：目录 hard link 不支持；进程内锁不能保护独立进程。选择文件系统租约加已有目录发布协议，文件原语另有独立决定。

## 影响

新选择产生新路径，旧引用不迁移、不覆盖。新 v2 读取会拒绝损坏文件、非法引用和未知协议；同内容重试仅忽略非语义的 locator/import time。旧版程序不保证读取 v2，回滚代码不能将已有 v2 强行当 v1；保留这些目录，使用旧 v1 实验或再次升级读端，不批量回写用户数据。

历史列表目前执行完整 v2 文件校验；性能优化属于后续按需审计工作，不将“未审计”改成“已验证”。不是新执行模式，不改变 Runtime/Pack 端口、24 小时预算、付费 opt-in 或 CandidateRun 状态机。

## 验证

离线回归覆盖身份变化矩阵、对象键规范化、u1/u2 并存、旧 v1 原始字节与历史起点保留、损坏/未来版本/owner/digest 拒绝、跨根读取和复制、读后来源变化的 staging 复核、Windows 保留路径别名、case-root junction、同内容八方与独立子进程幂等、冲突保全及换锁不删除。现有 sealed scene、历史、Pack、Comparison/evaluation 用例继续验证旧数据路径。构建、定向回归和完整门禁的实际结果在对应 PR，不把合成用例当真实 Runtime 通过。

现行契约见[证据与持久化](../../architecture/evidence-and-comparison.md#冻结任务保全)。
