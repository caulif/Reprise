# 决策：超限源文件与函数的限期例外

状态：accepted

## 问题

仓库约定单个源文件不超过 1000 行、函数与方法跨度不超过 100 行。Recovery 与 Candidate 编排、TUI、Runtime 端口仍有一批符号超过函数阈值。没有机械门禁时，例外清单会与代码漂移；把 100 行立刻做成无清单硬失败会逼出无回归保护的切分。

## 决定

文件阈值 1000 行对 `src/**/*.ts` 与 `test/**/*.ts` 立即生效。函数与方法跨度阈值 100 行对 `src/**/*.ts` 立即生效；测试文件只受文件上限约束，因为场景回调本身是数据密集型用例而不是生产函数。[`scripts/source-size-allowlist.json`](../../../scripts/source-size-allowlist.json) 中的符号在 **2026-09-06**（含当天之前）可以超限。owner 为 `@caulif`。到期或从代码中消失的条目必须删除；未登记超限必须失败。类声明本身不按函数阈值计算；文件总长仍受 1000 行约束。

`scripts/verify-source-size.mjs` 进入 `static` 与 `check`。自检构造 1001 行文件和 101 行函数，二者都必须使门禁失败。过期例外同样失败。

拆分每次只抽一个稳定职责，并跑直接受影响的 `dist/test`。禁止借例外做一次性架构重写。机械清单是唯一例外登记处；本文不复述符号表。

Candidate 运行路径放在 `src/application/experiment.ts`。Recovery 编排放在 `src/application/recovery/recover.ts`。

## 备选方案

**四个文件在同一变更里全部拆完。** 冲突面覆盖 application、infrastructure、TUI 和环境，失败无法归因。

**把 100 行立刻做成无例外硬门禁。** 当前工作树会红，逼出无回归保护的机械切分。

**不做拆分、只提高行数上限。** 上限存在是为了限制 review 与 agent 上下文，放宽等于取消约束。

## 影响

- Recovery 与 Candidate 的调用方仍从 `experiment.ts` 导入。
- 超限符号有明确 owner、到期日和机械核验，避免无限期例外。
- 文件阈值已经满足；函数阈值按清单限期整改。

## 验证

- `node scripts/verify-source-size.mjs --self-test` 拒绝 1001 行 `src`/`test` 文件、101 行函数、101 行方法、名为 `intake-tui-probe.ts` 的超限文件和过期例外；多个短方法组成的类和测试文件中的长回调不按函数超限失败。
- `node scripts/verify-source-size.mjs` 报告 0 个未登记超限、0 个过期例外。
- `src/application/experiment.ts` 少于 1000 行，并再导出 `recoverCodexExperiment`。
