# 决策：历史提取始终由来源 Pack 负责

状态：accepted

延续 [可选历史终稿提取端口](./2026-09-19-historical-artifact-extract-port.md)。

## 问题

现场 `start()` 曾从候选 Pack 取得历史提取器，重开 `comparePersisted()` 却按冻结 Case 的来源产品选择。跨产品运行因此可能对同一份历史事件得到不同的清单，甚至漏掉有成功写入记录的交付物。

Codex 自定义 `exec` 可以承载 JavaScript 调用和补丁文本。仅看到补丁字符串不足以证明写入成功；完全忽略此类调用又会把可识别写入表现为没有交付记录。

## 决定

现场与持久化对照均以 `taskCase.source.productId` 解析可选历史提取能力。候选 Pack 只控制当前候选 Runtime。旧 Case 没有封存清单时，仍在 comparison attempt 内派生清单，不改写 Case。

Codex 对 `custom_tool_call/name=exec` 仅静态解码单个 JSON 字符串补丁，且脚本必须完整匹配 `const patch = literal; const r = await tools.apply_patch(patch); text(r);`。补丁必须有唯一完整的起止标记，调用输出须是已完成且返回空成功对象的已知形状。解析仍通过现有补丁操作和路径校验，不执行历史 JavaScript。只有完整匹配已知只读调用包装与命令的 `exec_command` 可以跳过；动态表达式、额外写入、不完整补丁、不透明 shell 命令及无法核对的写入结果只产生 issue，不产出可信终稿。

## 备选方案

**继续按候选 Pack 提取。** 同一来源历史会随候选产品改变解释结果，无法维持 Case 的来源语义。

**执行历史 JavaScript 或 shell。** 会引入本机副作用，且无法证明执行环境与原会话相同。

**对所有 `exec` 都报未知写入。** 会把明确的读取检查也当作写入，导致刚重建的终稿被错误地抹去。

## 影响

历史文件仍标记为 `reconstructed_from_history`，sourceRefs 指向调用与结果事件；它不是原会话的文件句柄。静态策略只认识已观察到的限定语法，其他写入形状仍可能需要后续显式扩展。

## 验证

`test/products/historical-artifacts-extract.test.ts` 覆盖静态成功与动态、失败、越界反例；`test/application/workflow-history-source.test.ts` 覆盖 Codex 来源、Claude Code 候选的现场和持久化入口。
