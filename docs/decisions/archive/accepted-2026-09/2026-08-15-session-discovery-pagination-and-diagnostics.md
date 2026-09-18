# 决策：Session discovery 使用可分页诊断页

状态：accepted

## 问题

会话来源的 JSONL 目录可能很大，而且一个目录里会同时存在过大的、损坏的、已删除的或被 Reprise 排除的文件。原有 `discover()` 只返回数组，调用方只能以「结果数量等于 limit」猜测是否还有记录，也无法区分没有会话、扫描被截断和静默跳过损坏文件。缓存仅按产品名时，产品配置的 root 变化还可能复用错误结果。

## 决定

`SessionSourceAdapter.discover()` 返回产品中立的 `SessionDiscoveryPage`：

- 每个新的 metadata fingerprint 先建立完整、轻量的 `SessionSummary` index，再按 `updatedAt + sourcePath` 全局稳定排序并取展示页。`scanned` 表示该 index 覆盖的候选数，`skipped` 和聚合 `diagnostics` 说明其失败/排除事实；文件 mtime 仅用于候选 fingerprint，绝不作为跨页 event-time 排序的替代；
- `rootDiagnostics` 保存 metadata 枚举和不可变 summary index 的诊断，并在每个 cursor 页重复返回；Controller 只计入一次。`pageDiagnostics` 保留给只检查当前页的未来/第三方 adapter，当前本地 JSONL Pack 不用它伪装全局 index 的失败归属；
- `nextCursor` 是不透明 token（当前 v2），编码规范化 root、已枚举候选文件的 SHA-256 fingerprint 和上一条全局排序结果的来源路径；不同 root、候选集合、排序项消失或无效 token 必须失败，不能混合旧页；
- 查询传入 `cursor`、`signal`、精确 `excludeSessionIds` / `excludeSourcePaths`、显式来源目录 `excludeRoots` 和 `refresh`，但 JSONL 格式解析仍只在 Product Pack 内。`excludeRoots` 匹配 `sourcePath` 而不是会话 cwd；摘要 index 只在进程内按 `productId + root + fingerprint` 缓存，最多 4 个完成 index；每个 continuation 仍重枚举 metadata 并校验 fingerprint，`refresh` 丢弃命中的 index 后重建。当前两个本地 JSONL Pack 没有经验证的通用归档语义，不能预置 `includeArchived`。未来仅在具体 Pack 的来源格式提供可靠归档事实时扩展该过滤条件；
- `SessionSummary.startedAt` 与 `updatedAt` 均可缺失；`startedAtSource` / `updatedAtSource` 明确标记 `event` 或 `file-mtime`。未知时间在 UI 显示为未知，而不是伪造 Unix epoch；按 epoch 值排序时未知项稳定落在已知项之后，并以来源路径打破平局；
- Controller 以产品和规范化 root 缓存页面；cursor 的候选集合 fingerprint 只用于拒绝不连续的翻页，不把无 watcher 的内存 cache 伪装成实时索引。`m` 仅在 `nextCursor` 存在时加载下一页，`r` 丢弃该 root 的缓存并从第一页刷新；切换产品或开始新的发现会取消尚未完成的发现。

为不扩大一次迁移，`discoverCodexSessions()` 与 `discoverClaudeSessions()` 保留为只取第一页 `items` 的兼容包装；Pack port 和 TUI 只使用 page 协议。

## 补充（2026-08-16）：Claude history 覆盖率

Claude 的 `history.jsonl` 是提示历史索引，不是可冻结的 session transcript。Claude Pack 在发现 `projects` JSONL 后，以有界、逐行、schema-checked 的方式只读取相邻 `history.jsonl` 的 `sessionId`；对于没有同名本地 transcript 的历史 session，返回聚合诊断 `history-without-transcript`，并计入 `skipped`。这些条目不会成为可选择的 `SessionSummary`，避免用户选择后才发现无法 inspect/import。缺失、不可读或过大的可选 history index 不阻断 transcript discovery，只以既有安全诊断报告。

默认 Claude root 解析 `CLAUDE_CONFIG_DIR/projects`，未设置时才回退 `~/.claude/projects`；不读取凭据、设置文件或历史正文。该兼容性使曾以独立 Claude 配置目录运行的用户能够显式让 Reprise 扫描相同的 transcript 根。

## 后果

- 适配器必须报告本地坏文件的聚合诊断，不得用空 `catch` 隐去它们；diagnostic 的 `samplePath` 只能是 root-relative 受限路径，无法安全相对化时省略；
- 选择具体产品之前不读取任何该产品的 session 根目录；
- UI 可以明确展示「还有更多」和已跳过数量，而不把 150 条误称为完整结果；产品页以及选择产品后的项目/会话页均展示 index 级跳过数和按 code 聚合的安全摘要；同一不可读目录、坏文件或排除项不会随分页被重复计入；
- 兼容旧单值 `sessionsRoot` 时，显式 `pack` 优先；否则多 Pack 仅映射到历史 Codex Pack（不依赖 Pack 数组顺序），单 Pack 映射到该唯一 Pack。产品 keyed root 可显式覆盖该兼容映射；
- 两个 Pack 都通过 `fs.opendir()` 有界遍历并逐行读取摘要；目录按稳定的广度优先批次、每批最多 8 个目录任务执行，摘要 index 也每批最多 8 个文件任务，不能把整棵目录树或全部文件读取放入无界 `Promise.all()`。单个摘要的 4 MiB / 50,000 行预算触发 `too-large`。inspect/import 的读取方式见[流式正文决策](./2026-08-27-stream-session-transcript-io.md)。
- 严格的全局 event-time 排序与“在尚未读取后续候选前先展示最新首屏”不能同时成立。因此首个页面等待可取消的完整轻量 index；index 完成后，结果页和 cursor 页才渐进展示。目录 symlink/junction 一律作为 `unsupported-entry` 跳过，不跟随到 root 外或循环目录。Windows ACL 拒绝由临时目录上的 `icacls.exe` fixture 覆盖，cleanup 先移除 deny ACE，绝不更改真实历史目录。

## 验证

- `test/session-discovery-page.test.ts` 验证连续页、全局 event-time 排序跨 cursor 边界、index diagnostics 不重复、未知时间排序、root-relative 坏文件诊断、跨 root cursor 拒绝、候选集合变化后的 stale cursor，以及显式 refresh 才重建产品 scoped index；`test/session-summary-streaming.test.ts` 验证 1,500 文件树的首页边界与完整、无重复目录枚举、directory junction/symlink 循环不被跟随、枚举后删除文件的 ENOENT 聚合、Windows ACL 拒绝聚合、流式摘要的 file-mtime fallback、Codex 最早事件开始时间、格式错误与超限诊断；
- `test/product-first-intake.test.ts` 与 `test/codex-intake.test.ts` 验证惰性产品选择、产品隔离、legacy root 的 Pack 归属、快速切换后晚到 discovery 结果不会覆盖当前产品、翻页不重复计 root diagnostics，以及项目/会话页持续展示累计跳过数和分类 diagnostics；`test/paths.test.ts` 验证 `excludeRoots` 不把相邻路径（如 `C:\work\app2`）误判为 `C:\work\app` 的子目录；
- `npm run check` 是本决策的集成门禁。
