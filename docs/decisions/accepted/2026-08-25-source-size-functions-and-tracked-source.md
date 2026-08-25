# 决策：函数长度按方法计，受控源码不得被忽略

状态：accepted

## 问题

把整个 `ClassDeclaration` 按 100 行函数阈值计算，会把由多个短方法组成的类判为超限。为过门禁而把 `#private` 改成公开字段、把方法挪到模块再挂回 `prototype`，会扩大可变状态并关闭类型安全规则。同时 `src/tui/intake-tui*.ts` 曾被 `.gitignore`、source-size 和 ESLint 一起排除，干净检出无法复原运行所需源码。

## 决定

`scripts/verify-source-size.mjs` 度量 `src/**/*.ts` 与 `test/**/*.ts` 的文件行数；对 `src/**/*.ts` 再度量 constructor、method、function、arrow/function expression 的 AST 跨度。类声明本身不按函数阈值失败；文件仍不得超过 1000 行。测试文件只受文件上限约束。真实 `src/**/*.ts` 不得因文件名被跳过。`scripts/verify-tracked-source.mjs` 进入 `static` 与 `check`：`src/` 与 `test/` 不得存在被 Git 忽略的 TypeScript；受控源码的相对导入目标必须受 Git 控制；ESLint ignore 以 ESLint `isPathIgnored` 为准，不得覆盖受控 `src/`/`test/` TypeScript 文件；`tsconfig.exclude` 不得列出 `src/` 或 `test/` 路径；jscpd/knip ignore 不得指向已删除的受控源码。自检分别构造 ignored `src/*.ts`、未跟踪相对导入、过期 exclude、以及双引号/`src/**/*.ts`/多段 ESLint ignore，这些都必须失败。

## 备选方案

**继续把整个 class 当作一个函数。** 会诱导 prototype 回挂和公开内部状态，而不是按职责抽短方法。

**只在文档里禁止忽略真实源码。** 没有机械核验时，`.gitignore` 与 ESLint ignore 会再次把产品源码排除出 CI。

**允许带 generated 标记的源码按文件名跳过。** 当前仓库没有受控生成器能重建 `intake-tui*.ts`；在有生成器与 do-not-edit 标记之前不开放文件名豁免。

## 影响

- 由多个短方法组成、总计超过 100 行的类可以通过函数门禁，但仍受 1000 行文件上限约束。
- TUI 与 Runtime 实现必须出现在 Git 与 lint 扫描范围内。
- 本地 `check` 增加一个廉价 git/eslint 范围检查。

## 验证

- `node scripts/verify-source-size.mjs --self-test` 拒绝 101 行方法，不把宽类或测试长回调判为函数超限；`src/intake-tui-probe.ts` 与 `test/huge.test.ts` 超限必须失败。
- `node scripts/verify-tracked-source.mjs --self-test` 拒绝 ignored `src` TypeScript、未跟踪相对导入、`tsconfig.exclude`/`jscpd` 过期路径，以及双引号、`src/**/*.ts` 和多段 ESLint ignore。
- `git ls-files --others -i --exclude-standard -- src test` 对 `*.ts` 无输出。
