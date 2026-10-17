# 决策：候选成果捕获先封存、后生成运行范围证据

状态：accepted

## 问题

候选结束后的 capture 与 Runtime stop/close 一样受 cleanup 阶段截止约束。旧流程先对可变工作区做全量 fingerprint，再复制快照。安装后的依赖使第一次扫描消耗大量时间并可能触及扫描预算；复制只识别同层 lockfile，pnpm 工作区成员的依赖不能复用根安装证明。超时只取消外层等待，扫描、整文件读取和部分 Git 子进程仍可能继续。

## 决定

- capture 先把成果复制到私有 staging。逐文件流式复制，比较源流与落盘 SHA-256，复制预算限制文件数、总量和单文件大小；只对完成的 staging 做有界并发、可取消 fingerprint。预算截断或跳过条目不产生成功快照。运行范围与文本摘录均来自该副本，不再扫描可变工作区；省略路径不被误报为删除。
- 沿用已安装依赖的同层 manifest、lockfile、安装标记规则。pnpm 成员目录另须有本地 package.json、根 package.json、pnpm-workspace.yaml、pnpm-lock.yaml、根安装标记，以及根锁或已安装 node_modules/.pnpm/lock.yaml 的 importers 段中准确匹配的普通成员键；不能识别的 YAML 表达保守保留。省略依赖时仍保留已安装锁凭据；根锁被改写时不覆盖该交付，而记录凭据路径及在隔离副本中恢复的步骤。不是按目录名字或 Git ignore 普遍排除构建与交付文件。显式 retainPaths 继续优先。
- Runtime stop/close/release 默认各 10 秒，capture 独立默认 60 秒；显式 cleanupTimeoutMs 继续覆盖全部阶段，开始事件记录实际阶段预算。信号传入复制流、哈希、扫描、Git refs 子进程和发布退避；已开始的原子 Store 提交不能回滚，后续提交前重新检查信号。外部端口不响应取消时仍保留 unknown 和资源所有权，不能宣称底层已退出。
- 快照发布使用有界 Windows rename 重试，禁止复制 fallback；完整标记只在复制、指纹验证和目录发布之后写入。只读 Comparison 继续要求 complete，不能回退到 live workspace。任务判断与成果可用性仍是两项独立事实。
- 失败保留 live workspace 和本次私有 staging，incomplete 标记记录失败阶段和 staging 名称，原错误继续传播。未发布失败可用新 staging 重试；存在目标目录或完整标记时拒绝覆盖，保留既有证据，不把残留目录自动认证为完整。同一 provider 拒绝同 run 的并发捕获。

## 备选方案

**只放宽超时。** 不能消除无效依赖遍历、预算截断和后台 I/O，故不采用。独立有限预算只给必要复制、验证与 Windows 文件锁退避留出时间。

**按 Git ignore 或目录名称排除产物。** 非 Git 任务和显式交付可能依赖这些文件，故只扩展已有的安装证明规则，并保留 retainPaths。

## 影响

不修改旧实验结果、旧快照或历史交付，不新增模型调用。完整标记不是持续防篡改或断电持久性承诺；文件 SHA-256 与 scope 是封存时的字节证据，不认证交付语义。源 Runtime 应已停止；同权限外部进程并发修改工作区不属于原子目录快照保证。

## 验证

回归见 [candidate-capture.test.ts](../../../test/application/candidate-capture.test.ts)，覆盖生产捕获入口、成员依赖与非成员交付、保留路径、失败重试、取消和已有快照保护。Comparison 的 missing/incomplete 回归继续适用。
