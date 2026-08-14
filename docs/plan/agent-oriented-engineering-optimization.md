# 面向 Agent 协作的工程化优化：开发任务

> 状态：方面 0–L 已落地（2026-08-14）。这是当前主任务文档。
> 组织方式：按**方面**组织，每个方面一次改完。方面之间只有依赖关系，没有批次划分——不存在「第二批再回来改同一个东西」。
> 机制来源：`deepseek-ai/deepseek-harness` @ `47f9438`（下称 dsh）。每个方面末尾标注它借鉴了什么、以及我们刻意缩小了什么。
> 事实标注：**[实测]** 本机命令输出 · **[源码]** 读 checkout 得到。

## 已拍板的决策

| # | 决策 | 影响的方面 |
|---|---|---|
| 1 | 建立 `docs/decisions/` | A（已落地），记录见[建立决策记录](../decisions/accepted/2026-08-14-establish-decision-records.md) |
| 2 | `AGENTS.md` 用中文 | B。预算单位因此改为**字符数**，见 C-5 |
| 3 | 门禁脚本用 `.mjs`，不引入 `tsx` | C、D、E。全部门禁零新增依赖 |
| 4 | 覆盖率起始阈值取当前实测值 | F。阈值只升不降 |
| 5 | `docs/` 受控边界：一次性材料进 `docs/.local/`，长期材料受控 | A（已落地），记录见[文档受控边界](../decisions/accepted/2026-08-14-documentation-version-control-boundary.md) |

## 0. 执行前提：构建当前是红的

在做任何门禁之前必须先修好构建，否则所有方面都无法验收。

`npm run build` 当前失败于两个类型错误 **[实测]**：

```
scripts/claude-real-smoke.ts(65,95): error TS2367: This comparison appears to be unintentional
  because the types '"waiting_input" | "aborted"' and '"cancelled"' have no overlap.
scripts/claude-real-smoke.ts(79,25): error TS2339: Property 'observableConfig' does not exist
  on type 'TargetRunner'.
```

两处都是脚本写了 `TargetRunner` 上不存在的 API **[源码]**：

- `TurnSettlement['status']` 的实际取值是 `'completed' | 'failed' | 'waiting_input' | 'aborted'`（`src/core/runtime.ts:14`），没有 `'cancelled'`。第 65 行的三分支判断应改为对 `'completed' | 'failed' | 'aborted'` 取值，其余落到 `'unknown'`。
- `TargetRunner` 没有 `observableConfig`。要么在 `src/core/runtime.ts` 的端口上正式声明它（并在 Codex、Claude Code 两个实现里都提供），要么删掉第 79 行改从已有事件取配置事实。**倾向后者**：为了一个 smoke 脚本扩端口不划算，而 `claude-code.system_init` 事件里已经有 init 信息。

修完立刻做两件事，否则同类问题会再次发生：

1. `scripts/claude-real-smoke.ts` 当前**未纳入版本控制** **[实测]**。它已经能让 `tsc` 变红却不在任何人的检出里，这是最坏的组合。要么提交它，要么从 `tsconfig.json` 的 `include` 里排除未受控脚本。选择提交。
2. 把 `smoke:claude` 挂进 `package.json` 的 scripts（现在只有 `smoke:codex` 和 `smoke:codex:recovery`），否则它是无人调用的死脚本。

**验收**：`npm run check` 退出码 0。

## 任务总览

| 方面 | 内容 | 状态 | 验收命令 |
|---|---|---|---|
| 0 | 修复构建 | **已完成** | `npm run build` 绿；`smoke:claude` 已挂 |
| A | 文档体系与受控边界 | **已完成** | 受控 docs 边界与 `docs/.local/` 已落地 |
| B | 分层 `AGENTS.md` | **已完成** | 根 / `src/` / `docs/` 三份 + `CLAUDE.md` 一行 |
| C | 文档与决策门禁 | **已完成** | `npm run verify:docs` |
| D | TUI 快照基线 | **已完成** | `npm run audit:tui:check`（41 帧） |
| E | 门禁编排 | **已完成** | `node scripts/run-gates.mjs check` |
| F | 覆盖率门禁 | **已完成** | 阈值 88 / 76 / 87；记录见[覆盖率阈值](../decisions/accepted/2026-08-14-coverage-thresholds.md) |
| G | 生成式文档 | **已完成** | `npm run verify:generated` |
| H | Agent 可见输出快照 | **已完成** | `node --test dist/test/snapshots.test.js` |
| I | 两个上帝对象 | **已完成** | `src/` 无 1200 行以上文件 |
| J | 死代码与重复 | **已完成** | knip / jscpd 观察模式 |
| K | CI 分 lane | **已完成** | `static` / `test` / `audit` / `coverage` + 聚合 |
| L | 提交纪律 | **已完成** | `git status --porcelain` 行数为 0 |

---

## A. 文档体系与受控边界（已完成）

本次重构已经落地，此处记录结果供后续方面引用。

**做了什么**

- 受控 `docs/` 文件从 190 降到 79 **[实测]**，其中 42 个是 `tui-audit/frames/`（方面 D 会把它变成真基线），实际内容文档 37 个。
- 新增 `docs/decisions/{proposed,accepted,superseded}/` 与两份自举记录。
- 取消 `docs/analysis/`、`docs/feedback/`、`docs/archive/` 三个目录。仍有未闭合工作的 4 份文档迁入 `plan/`（`current-implementation-gap-and-correction-plan.md`、`optimization-round-6.md`、`agent-system-prompt-redesign.md`、`user-centered-end-to-end-optimization.md`），其余移入 `docs/.local/`。
- `docs/further-development-plan.md` 迁入 `plan/`，并删除 `documentation-structure.md` 里「不得移动或删除」这条保护性规则——它是防误删的补丁，不是长期规范。
- `.gitignore` 用一条 `/docs/.local/` 表达「本地保留」，用 `/docs/tui-audit/*` + `!/docs/tui-audit/frames/` 表达「产物不受控、基线受控」。
- `.gitattributes` 把 `docs/tui-audit/frames/**` 固定为 `text eol=lf`。原本只声明了 `-whitespace`，而 `core.autocrlf` 会在 Windows 检出时把帧转成 CRLF，生成器写的却是 LF——不锁定行尾，方面 D 的基线每次重新生成都会产生全文件 diff，基线立即失效。

**未做、留给后续方面的**

`docs/documentation-structure.md` 和 `docs/AGENTS.md` 里已经引用了 `npm run verify:docs`，但该命令还不存在（方面 C）。这是有意的：先把规范写成可执行的形式，再实现执行者。

**借鉴 dsh**：文档 tier 分工与「一份事实一个归宿」。**刻意不借鉴**：双语三件套、`archived/` 的 blob hash 密封、6 类分类目录。

---

## B. 分层 AGENTS.md

**现状**：全仓库 0 个 `AGENTS.md` / `.cursor/rules` **[实测]**。Agent 每次会话要靠翻 `docs/`（34 份内容文档）重新发现约束。

**目标**：三个文件承担「渐进式上下文披露」。根文件是每次会话都要的常驻约束；子树文件只放该子树独有的规则；`docs/AGENTS.md` 已完成。

### B-1 `AGENTS.md`（仓库根）

每条规则 1–3 行，且必须带一个指向归宿的相对链接（链接由方面 C 的门禁校验，规范搬家时会强制更新此文件）。内容必须覆盖下面这些条目，措辞用命令式而非叙述式：

| 类别 | 规则要点 | 归宿链接 |
|---|---|---|
| 怎么跑检查 | `npm run check` 是本地全量门禁；改文档只跑 `npm run verify:docs`；不要为一次改动默认跑全套 | 本文件方面 E |
| 构建依赖 | 测试跑的是 `dist/`，改完代码必须先 `npm run build`；`node --test` 直接跑源码不成立 | `package.json` |
| 端口边界 | 新增 Runtime 能力先改 `src/core/runtime.ts` 的端口，再改两个 Pack 实现；不在应用层判断产品类型 | `architecture/product-plugin-compatibility.md` |
| Schema 边界 | 持久化、模型输出、外部 JSON 的读写必须过 `src/core/schema.ts` 的 TypeBox `Value.Check`；同进程内的类型化边界不加运行时校验 | `architecture/persistence-and-crash-consistency.md` |
| 状态机 | CandidateRun 状态变化只能过 `src/core/state-machine.ts` 的 `assertTransition`，不在别处手写状态判断 | `architecture/run-outcome.md` |
| 事件日志 | 模型可见即须可重建：任何进入模型请求的输入都必须能从事件日志复原；新增模型可见输入必须新增事件 | `architecture/persistence-and-crash-consistency.md` |
| TUI 定位 | TUI 是事件日志的只读投影，不持有实验状态机，不伪造未公开的推理过程 | `product/tui.md` |
| 密钥 | 只存 `env:NAME` 引用，密钥值不写入任何 Reprise 文件；不读也不保存 Codex 凭据 | `product/overview.md` |
| 计费 | 真实 Runtime 调用必须显式 opt-in（环境变量），默认路径不产生外部费用 | `codex-smoke-gate.md` |
| 决策记录 | 改动跨模块协议、on-disk 格式、提示词契约、工具面、工程流程时，同一次变更必须新增或更新 `docs/decisions/` 记录 | `documentation-structure.md#决策记录` |
| 平台 | Windows 11 是唯一已验证平台；路径拼接和进程启动要按 Windows 优先考虑（`.cmd` shim 必须加引号） | `architecture/technology-selection.md` |
| 注释 | 不注释代码本身已经说清的事实；空 `catch` 必须写明它吞掉了什么、以及为什么其他情况到不了这里 | — |

### B-2 `src/AGENTS.md`

只放代码层独有、且根文件没有的规则。候选内容：分层依赖方向（`cli` → `tui` → `application` → `infrastructure`/`products` → `core`，不允许反向）、`products/` 下两个 Pack 必须实现同一份 `contract.ts`、`tui/pages/` 只做渲染不做业务判断、原子写一律用 `core/identity.ts` 的 `writeAtomic`（现在有三份实现 **[源码]**）。

**不要**把 `architecture/overview.md` 的内容摘抄过来。做法是从现有架构文档里**提取指令、留下解释**：架构文档回答「为什么」，`AGENTS.md` 回答「所以你现在必须做什么」。

### B-3 `CLAUDE.md`

dsh 的做法是 `CLAUDE.md` symlink 到 `AGENTS.md` **[实测]**，避免多产品各维护一份指令。Windows 上 symlink 需要开发者模式或管理员权限，因此改为：`CLAUDE.md` 只有一行 `见 AGENTS.md。`，并由方面 C 的门禁断言它不含其他内容（防止两份指令逐渐分叉）。

### B-4 验收

- 新会话中 Agent 只读 `AGENTS.md` 就能正确回答「改了 `src/core/schema.ts` 之后还要动什么」。
- 三个文件都在字符预算内（C-5）。
- `docs/AGENTS.md` 第 3 行现在是「根 `AGENTS.md` 尚未建立」的纯文本说明；本方面完成后把它改成指向 `../AGENTS.md` 的链接。方面 A 没有留下这条链接，是因为受控文档里不允许存在断链——门禁的第一个用户是它自己。
- 根 `AGENTS.md` 里没有任何一条规则是 `docs/` 已有内容的复述——判据：随机抽三条规则，去掉链接后它们都是「必须做什么」而不是「系统如何工作」。

**借鉴 dsh**：根文件放 standing orders、子树文件不重复根文件、每条规则自带链接。**刻意不借鉴**：11 个 `AGENTS.md`（我们只要 3 个）、symlink（Windows 权限问题）。

---

## C. 文档与决策门禁：`scripts/verify-docs.mjs`

**现状**：`eslint.config.js` 明确 `ignores: ['docs/**']` **[源码]**；`npm run check` 的四步没有一步读 `docs/`。规范的执行力为零，而且已经漂移过——重构前 `documentation-structure.md` 声明 `analysis/` 有 8 份，磁盘上是 9 份 **[实测]**。

**目标**：一个 `.mjs` 脚本，七项检查，全部一次实现。挂进 `package.json` 为 `verify:docs`，并进入 `check`。

### C-1 相对链接与锚点

- 枚举受控 Markdown：`git ls-files '*.md'`（用 git 而非 glob，天然跳过被忽略的路径）。
- 只检查非 `http`/`https`/`mailto` 的相对链接与图片。目标文件必须存在。
- `#fragment` 仅在目标是 `.md` 时校验。锚点集 = GitHub heading slug + 正文里的 `<a id="...">`。slug 规则：转小写、去掉除 `-` 和中日韩字符外的标点、空格转 `-`、重复 slug 追加 `-1`/`-2`。**中文标题必须支持**——本项目文档标题几乎全是中文，只实现英文 slug 等于这条检查形同虚设。
- 报错格式照抄 dsh：`文件:行  链接  (目标不存在 | 目标中没有该锚点)`。

**两个已经踩到的实现陷阱**，写门禁时必须避开（本次重构用一个临时校验脚本验证 34 份文档时都真实发生过）：

1. **按 `\r?\n` 切行，不要按 `\n`。** 本仓库的 Markdown 在 Windows 检出后是 CRLF，而 JS 正则里的 `.` **不匹配 `\r`**——`/^#{1,6}\s+(.*)$/` 在 CRLF 行上会完全失配，于是锚点集为空、每个带锚点的链接都被报成断链。这种失败模式很危险：它长得像「门禁抓到问题了」，实际是门禁自己坏了。
2. **`git check-ignore` 对已跟踪文件一律返回「未忽略」。** 用它判断「链接是否指向不受控路径」时，必须先用 `git ls-files` 的集合排除已跟踪文件，否则结论反向。同理，方面 A 里把已跟踪的产物移出版本控制必须用 `git rm --cached`，只加 `.gitignore` 规则对它们无效。

C-8 要求每条检查都被证明能拒绝一个坏输入，原因就是这个：门禁自身的缺陷只能靠反向用例发现。

### C-2 禁止指向不受控路径

受控文档不得链接 `docs/.local/`、`docs/tui-loop/` 等被忽略的路径——那些文件在别人的检出里不存在。判据：对链接目标跑 `git check-ignore`，命中即失败。

### C-3 目录模型一致性

`documentation-structure.md`「目录模型」代码块里列出的目录集合，必须与 `docs/` 下实际存在的受控目录集合完全相等。两个方向都要报：模型里有而磁盘没有、磁盘有而模型没有。这一条直接消灭本次重构前那类漂移。

实现细节：只比较**顶层**目录，`decisions/` 的三个生命周期子目录和 `tui-audit/frames/` 不参与比较，否则会把嵌套目录误当成顶层缺失。磁盘侧的集合从 `git ls-files docs/` 推导而非 `readdir`，这样 `docs/.local/` 与产物目录天然不参与比较。

### C-4 决策记录格式

只检查 `decisions/proposed/` 与 `decisions/accepted/`（`superseded/` 已冻结）：

- 第 1 行 `# 决策：<标题>`，第 2 行空，第 3 行 `状态：<proposed|accepted>`，且与所在目录一致。
- 文件名匹配 `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$`。
- 五节按顺序齐全：`## 问题` `## 决定` `## 备选方案` `## 影响` `## 验证`。
- `## 备选方案` 下至少有一个以粗体开头的段落（防止留空标题过检）。
- `accepted/` 中禁止出现 `## 计划`、`## 迁移计划`、`## 验收标准` 这类提案期标题——已生效的决策用现在时描述事实。

### C-5 字符预算

**中文项目必须用字符数，不能用 dsh 的 `wc -w`。** 中文没有空白分隔，按空白 token 计数会把一整段算成 1 个词，预算完全失效。

算法：读全文，先去掉 ```` ``` ```` 围栏代码块，再去掉 Markdown 链接的 URL 部分（保留链接文字），最后统计非空白字符数。

`scripts/doc-budgets.manifest.json` 首批四个条目（当前实测值 + 约 10% 余量）：

```json
{
  "AGENTS.md": 1600,
  "src/AGENTS.md": 1200,
  "docs/AGENTS.md": 1500,
  "docs/documentation-structure.md": 3300
}
```

实测：`docs/AGENTS.md` 1394 字符、`docs/documentation-structure.md` 2965 字符 **[实测]**。

报错必须把处理顺序写进消息里，照抄 dsh：`{路径}: {实际} 字符超出 {上限} 上限 —— 先把属于别层的内容搬走，再压缩本层内容，最后才提高上限并在 decisions/ 说明理由`。同时实现两条反向检查：manifest 里的文件不存在要报错（重命名忘记同步）；上限不是正整数要报错。

**上限是护栏不是压缩目标**：在上限以下时不要主动删内容，低于上限过多说明上限设高了而不是文档该更长。

### C-6 命名规则

受控 `docs/` 下的文件名必须是小写 `kebab-case`（例外白名单：`README.md`、`AGENTS.md`、`MASTER.md`），且不含 `final`、`latest`、`new` 或版本号后缀。

### C-7 `CLAUDE.md` 一致性

`CLAUDE.md` 必须只有一行指向 `AGENTS.md`（见 B-3）。

### C-8 验收

- `npm run verify:docs` 退出 0。
- 故意制造四种失败各一次并确认能被抓到：断链、目录模型漂移、决策记录缺 `## 备选方案`、`docs/AGENTS.md` 超预算。**每条检查都必须被证明能拒绝一个坏输入**，否则它可能和重构前那些恒真测试一样只是看起来在工作。

**借鉴 dsh**：`verify-md-links`、`verify-doc-budgets`、`verify-agent-note-format` 的检查内容与报错措辞。**刻意不借鉴**：`verify-md-wrap`（一段一行的排版约束对中文收益不明显）、`verify-export-jsdoc`（单包项目内部导出多，收益低）、翻译配对相关的全部门禁。

---

## D. TUI 快照基线

**现状**：`scripts/tui-audit-analyze.mjs` 只对新生成的帧做启发式检查——行宽溢出、面板上下沿宽度是否相等、compact 模式禁用字符、ANSI 逃逸泄漏、状态消息重复 **[源码]**。它**从不与已提交的帧比对**。所以 42 个受控帧目前不提供任何门禁价值，而 CI 注释却称这是「唯一能抓 layout drift 的检查」——启发式只能发现「明显坏了」，发现不了「布局意外改变了」。

第六轮的教训正好证明这个缺口：ScrollView 钉底导致选中项滚出视口、bracketed paste 未解包导致粘贴静默失效，两者都落在既有启发式规则之外 **[源码]**。

**目标**：帧从「碰巧受控的产物」变成逐字节基线，让任何渲染改动在 review 里显式可见。

### D-1 改动

- `scripts/tui-visual-audit.mjs` 增加 `--check`：把帧生成到临时目录，与 `docs/tui-audit/frames/` 逐字节比对。不等则报 stale、列出差异文件、并给出**首个差异行号与两侧该行的 `JSON.stringify`**（差异常常是尾部空格，不转义看不出来）。修复命令直接写在报错里：`运行 npm run audit:tui 并提交 docs/tui-audit/frames/`。
- 帧的写入必须显式用 LF（`\n`），不依赖平台默认，与 `.gitattributes` 的 `eol=lf` 对齐。
- `package.json` 增 `audit:tui:check`，CI 从 `audit:tui:ci` 切到它。启发式分析（`tui-audit-analyze.mjs`）保留——它和基线比对是互补的：基线抓「变了」，启发式抓「新写的帧本身就是坏的」。
- HTML 镜像不再受控（方面 A 已处理），生成仍照旧，只是落在被忽略的路径上。

### D-2 一次性的基线校准

当前工作树里有一批新增和修改过的帧还没进基线。执行一次 `npm run audit:tui` 后提交全部帧，作为基线零点。这一步必须在方面 I（拆分 `tui/controller.ts`）**之前**完成，否则无法区分「重构导致的渲染变化」和「基线本来就没对齐」。

### D-3 验收

- `npm run audit:tui:check` 在干净树上退出 0。
- 手动改一个 TUI 字符串后重跑，必须失败且指出正确的帧和行号。

**借鉴 dsh**：`gen-X.ts --check` 的「生成即校验」——同一个脚本两个模式，`--check` 只做整文件字节比较并给出修复命令。**刻意不借鉴**：把 HTML 也纳入基线（帧是实质，HTML 是派生展示）。

---

## E. 门禁编排：`scripts/run-gates.mjs`

**现状**：`test`、`audit:tui`、`smoke:codex`、`smoke:codex:recovery` 每个都以 `npm run build` 开头 **[源码]**，CI 里重复全量编译。同时有一批脚本既不在 npm scripts 也不在 CI 里：`tui-full-flow.ts`、`tui-case-replay.mjs`、`codex-real-runner.ts`、`tui-audit-screenshots.mjs`、`tui-intake-walkthrough.mjs`。

**目标**：一份门禁声明，切出三种执行范围，共享前置只跑一次。

### E-1 数据结构

照抄 dsh 的 `Gate`，去掉我们用不到的字段：

```js
// { id, label, command, args, needs?, allowFailure? }
```

- 就绪的 gate（`needs` 全部通过）并发执行；依赖失败的 gate 标记为 skipped，原因写 `依赖失败或被跳过: <ids>`，而不是级联报一堆无关错误。
- 启动前校验图：重复 id、未知依赖、成环，三者都要在跑任何命令之前报错。
- `allowFailure` 的 gate 在汇总里前缀 `NON-BLOCKING`，不影响退出码——这是新门禁「先观察再阻塞」的通道，方面 J 会用到。
- 汇总一行：`run-gates: N 通过, M 失败, K 跳过, 耗时 Xs`，并重列失败项。

### E-2 三个 mode

| mode | gates |
|---|---|
| `docs` | `verify:docs`（方面 C） |
| `check` | `build` → {`typecheck`, `lint`, `test`, `check:node`, `audit:tui:check`, `verify:docs`, `verify:generated`} |
| `ci` | `check` 的全部 + `test:coverage` |

关键收益：`build` 是一个 id，所有下游 gate `needs: ['build']`，不再各自重复编译。`typecheck` 与 `build` 有重叠（都跑 `tsc`），保留 `typecheck` 是因为它是 `--noEmit` 的快速失败路径——但它应当与 `build` 并列而非串行。

`package.json` 的 `check` 改为 `node scripts/run-gates.mjs check`，保留各原子 script 供单独调用。

### E-3 游离脚本收编

每个未挂载的脚本二选一，不允许留在中间态：挂进 npm scripts 并声明它属于哪个 mode（或明确「不属于任何 mode，仅手动」），或者移出 `scripts/` 到 `docs/.local/` 作为本地工具。判据：它是否会因为无人调用而静默腐烂——`scripts/claude-real-smoke.ts` 已经证明会（方面 0）。

### E-4 验收

- `node scripts/run-gates.mjs check` 的墙钟时间短于当前 `npm run check && npm run audit:tui:ci`。
- 故意让 `lint` 失败，确认 `test` 报 skipped 而不是也失败。
- `scripts/` 下没有既不在 npm scripts 也不在 mode 里的 `.ts`/`.mjs`。

**借鉴 dsh**：`Gate` 接口 + `needs` DAG + 共享前置只跑一次 + 依赖失败传播 + `allowFailure` 观察模式。**刻意不借鉴**：14 个 mode、并发上限调优、`*:contracts-ready` 变体（我们没有 Typert 那样的生成契约前置）。

**这个方面唯一的反对意见**：给 7 个门禁造调度器可能是过度工程。判据是共享前置的浪费是否真实存在——它存在（4 个 script 各自 build）。但如果实现后发现 `run-gates.mjs` 超过 200 行，说明抄多了，应当砍回到只保留 `needs` 和并发两个能力。

---

## F. 覆盖率门禁

**现状**：`test:coverage` 有 script、无阈值、不在 `check` 里、不在 CI 里 **[源码]**。当前测试规模是 24 个测试文件、8155 行测试代码，对应 68 个源文件、15401 行源码 **[实测]**。

**目标**：CI 有一条会因覆盖率下降而失败的检查，阈值取当前实测值，只升不降。

### F-1 零新增依赖

Node 自带阈值参数，不需要 vitest 或 c8 **[实测]**：

```
--test-coverage-lines=<n>  --test-coverage-branches=<n>  --test-coverage-functions=<n>
--test-coverage-exclude=<pattern>  --test-coverage-include=<pattern>
```

这与「门禁脚本用 `.mjs`、不引入 `tsx`」的决策一致：整个方面 F 不新增任何 `devDependency`。

### F-2 阈值取值步骤

必须按顺序做，因为方面 0 之前拿不到数字：

1. 方面 0 完成，`npm run build` 绿。
2. 跑 `npm run test:coverage`，记录 lines / branches / functions 三个总体百分比。
3. 三个数字**各向下取整到整数**写进 `package.json`，不留缓冲——留缓冲等于允许覆盖率下降。
4. 把这三个数字和测量日期写进一份 `docs/decisions/accepted/` 记录，说明「只升不降」的规则，否则半年后没人知道这些数字为什么是这样。

### F-3 排除清单

用 `--test-coverage-exclude` 显式排除，**不要靠降低阈值来容纳未覆盖代码**——这是 dsh 那套 100% 阈值能持续的关键：

- `dist/test/**`、`dist/scripts/**`（测试与脚本本身不计）
- `dist/src/**/types.js`（纯类型模块编译产物）
- `dist/src/cli/main.js`（进程入口，由 `check:node` 覆盖）

`src/tui/` **不排除但也不单独设高阈值**：它占 5705 行、37% 的源码 **[实测]**，渲染正确性由方面 D 的帧基线承担，重复用行覆盖率约束它没有意义。等方面 I 把 `controller.ts` 里的业务逻辑抽出来之后再单独讨论。

### F-4 未覆盖行的解释框架

照抄 dsh `docs/testing.md` 的判断顺序，并写进根 `AGENTS.md`：

> 未覆盖的行往往是门禁正确标记出的死代码，应当删除，而不是补一个测试去覆盖它。行覆盖率是必要条件，永远不是充分条件——它只证明代码跑过，不证明功能如交付那样工作。

第六轮已经点名了一批确定的死代码 **[源码]**：`widgets.separator`、`viewport.headerRowCount`、`COMPACT_HEADER_ROWS`、`harness-model-config.safeBaseUrlDisplay` 生产零调用，`CodexExperimentPreflight.sourceBaseline` 的 `'partial'` 分支无生产路径。**先删这些再测量**，否则阈值会被死代码压低，之后删掉反而显示为覆盖率上升。

### F-5 验收

- `npm run test:coverage` 在当前树上退出 0；人为注释掉一个被测函数的调用后退出非 0。
- CI 有独立的 coverage 检查（方面 K）。

**借鉴 dsh**：`perFile` 思路、显式 exclude 清单而非降阈值、「未覆盖行=死代码信号」的解释框架。**刻意不借鉴**：per-file 100%（需要 exempt-heavy 双 lane、自定义 reporter 等三套配套设施才可持续）、覆盖率豁免清单机制。

---

## G. 生成式文档

**现状**：`src/core/schema.ts` 已经是 TaskCase / RunRecord / EventEnvelope 的 TypeBox 单一事实源，持久化读写用 `Value.Check` **[源码]**；而 `architecture/` 里的事件类型与字段说明是手写的。这是「手写清单必然漂移」的教科书场景——方面 A 之前 `analysis/` 的计数漂移就是同一个病。

**目标**：事件类型与配置字段目录由 schema 生成，手写部分与生成部分在同一份文档里共存。

### G-1 生成区语法

照抄 dsh 的行级 HTML 注释 **[源码]**，加上生成器名字，让读者知道该跑什么：

```
<!-- BEGIN GENERATED event-catalog (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
<!-- END GENERATED event-catalog -->
```

约束：标记必须独占一行、不允许嵌套、slug 必须成对匹配。

### G-2 生成内容

`scripts/gen-docs.mjs` 从 `dist/src/core/schema.js` 读 TypeBox schema（因此 `needs: ['build']`），产出两个区：

- **事件类型目录**：`EventEnvelope` 判别联合的全部 `type` 取值及其 payload 字段，写入 `architecture/persistence-and-crash-consistency.md`。
- **持久化记录字段**：`RunRecord`、`TaskCase` 的字段名、类型、是否可选，写入 `architecture/run-outcome.md`。

`--check` 模式与方面 D 同构：整文件字节比较，报 stale 并给出修复命令。挂 `gen:docs` 与 `verify:generated` 两个 script，后者进 `check`。

### G-3 这个方面的优先级最低

`src/core/schema.ts` 变更频率低，所以 G 的收益不如 C/D/F 直接。**建议在下一次真正改 schema 时顺手完成，而不是现在专门做**。如果先做，风险是写完一个半年不触发的门禁。

### G-4 验收

- 改 `src/core/schema.ts` 加一个事件类型后不重新生成，`npm run verify:generated` 失败并指出该文件。

**借鉴 dsh**：generate + `--check` 同脚本、行级 marker 语法。**刻意不借鉴**：6 类生成目录、`ts.Program` 级别的 API 提取、文档站构建。

---

## H. Agent 可见输出快照

**现状**：Reprise 的核心产物是 Agent 行为，而 Agent 行为由**提示词、工具 schema、报告模板**决定。这三类文本目前只被单元测试间接覆盖。`architecture/agent-roles-and-system-prompts.md` 有 566 行，且文档自述是「待确认的设计对齐基线」——也就是说文档与实现的一致性靠人工核对。

第六轮记录了这类盲区的两个真实后果 **[源码]**：`comparison-report.test.ts` 手工喂 `tokenCount: 128`，掩盖了整条 token 采集链路是死代码；客户端合成事件双重前缀导致 `rejectedApprovals` 恒为 0，而事件名从未被端到端断言过。

**目标**：模型可见的文本进快照，改动时在 review 里显式可见。

### H-1 快照内容

新增 `test/snapshots.test.ts` + `test/snapshots/*.txt`：

- 三个 Agent（Recovery / Controller / Comparison）组装完成的 system prompt 全文。
- 暴露给 Runtime 与 Agent 的工具 schema（工具名、描述、参数 JSON Schema）序列化结果。
- `comparison-report` 对一份固定输入的渲染输出。

### H-2 实现约束

- 快照文件用 LF，`.gitattributes` 同 D-1 处理，否则 Windows 上每次都是全文件 diff。
- 更新机制：`UPDATE_SNAPSHOTS=1 node --test ...` 重写，默认模式只比对。
- **固定输入必须来自真实 payload 形状**。已有 `test/fixtures/codex-session.fixture.json`，token 相关的快照要用真实会话片段而不是手工构造的 `{ tokenCount: 128 }`——否则会重复制造第六轮那种「测试绿但链路断」。

### H-3 验收

- 改任一 Agent 的 system prompt 一个字，`node --test dist/test/snapshots.test.js` 失败并显示 diff。
- `architecture/agent-roles-and-system-prompts.md` 里的提示词描述与快照一致（人工核对一次，之后靠快照维持）。

**借鉴 dsh**：snapshot tier 作为「模型可见 / 用户可见输出」的证据，与单元测试分工。**刻意不借鉴**：真实 API 的 e2e 快照录制（会产生费用，且我们已有 `codex-smoke-gate.md` 管这条路径）。

---

## I. 两个上帝对象

**现状** **[实测]**：

| 文件 | 行数 |
|---|---|
| `src/tui/controller.ts` | 1868 |
| `src/application/experiment.ts` | 1438 |
| `src/infrastructure/recovery-tools.ts` | 799 |
| `src/products/codex/runtime-port.ts` | 644 |
| `src/environment/local-workspace-provider.ts` | 621 |
| `src/products/claude-code/runtime-port.ts` | 560 |

前两个合计 3306 行，占 `src/` 15401 行的 21%。

**目标与既有共识的关系**：第六轮 §8 明确把「为拆而拆 controller.ts」列入不做，理由是「当前主体是有真实读写的状态机，先抽 `intake-input.ts` 一刀即可」 **[源码]**。本方面遵守这个共识，**不做全面重构**，只做两刀，判据是可测性而非行数美观。

### I-1 `src/tui/controller.ts`

抽出**输入处理**：bracketed paste 解包、文本编辑、命令前缀匹配、各页面的按键分发。这部分是纯函数，抽出后可以直接单元测试，而现在它们只能通过整个 controller 的字符串渲染路径间接触及——第六轮的粘贴失效和建议列表不可选两个缺陷都出在这里。

目标：`controller.ts` 降到 1200 行以下，抽出的模块有独立测试。

### I-2 `src/application/experiment.ts`

按实验生命周期的四个阶段切开：preflight、delivery、inspection、report 投影。这四段之间的耦合是顺序耦合而非状态共享，切开后每段可以独立喂输入测试。第六轮点名的 token 投影错误（查错了 payload 层级、且累加语义错）就在 report 投影段里。

目标：降到 1000 行以下。

### I-3 顺序约束

必须在方面 D-2（基线校准）之后做，否则渲染变化和基线未对齐混在一起无法区分。必须在方面 F（覆盖率）之前或同时做，因为拆分会显著改变覆盖率数字——先测量再拆分，阈值会立刻失效。

**建议顺序：D-2 → I → F**。

### I-4 验收

- `src/` 下无 1200 行以上文件。
- 抽出的输入处理模块有直接测试，且其中一条是**带 bracketed paste 包裹标记**的输入（`\x1b[200~...\x1b[201~`）——第六轮的教训是 mock 裸串永远测不出真实终端行为。
- `npm run audit:tui:check` 仍然通过（拆分不改变渲染）。

---

## J. 死代码与重复

**现状**：无死代码检测、无重复检测。第六轮手工点出了一批（见 F-4）和四处重复：`formatBytes` 在 `history.ts` 与 `run.ts` 各一份、`SAFE_RUNTIME_ID` 与 `core/identity.SAFE_ID` 完全相同、原子写有三份实现、一段 JSDoc 出现两次且第一份挂错对象 **[源码]**。

**目标**：把手工发现变成自动发现。

### J-1 做法

- `knip` 检测未使用的文件、导出、依赖；`jscpd` 检测跨文件重复（dsh 用 `minTokens: 60, minLines: 6, mode: mild` **[源码]**）。
- 两者都是 `devDependency`，与「门禁脚本用 `.mjs`」的零依赖倾向有张力。因此**先以 `allowFailure` 观察模式上线**（方面 E 的 `NON-BLOCKING` 通道），跑一个月看它们报的是真问题还是噪音，再决定是否转为阻塞或直接移除。
- 先手工清掉 F-4 和上面列出的存量问题，再上线工具——否则第一次运行会淹没在存量报告里，工具立刻被忽略。

### J-2 验收

- `node scripts/run-gates.mjs check` 输出里 knip / jscpd 显示为 `NON-BLOCKING`。
- 存量清理完成后，两者的报告条数为个位数。

---

## K. CI 分 lane

**现状**：单 job、双平台 matrix、15 分钟超时，步骤是 `npm ci` → `npm run check` → `npm run audit:tui:ci`，失败时上传 `docs/tui-audit/` **[源码]**。Action 已全部 pin 到 commit sha，`concurrency` 取消已配置——这两点做得对，不要动。

**目标**：拆 lane 让失败定位更快，并补上聚合检查。

### K-1 改动

四条 lane，都复用方面 E 的 mode：

| lane | 内容 | 平台 |
|---|---|---|
| `static` | typecheck、lint、`verify:docs`、`verify:generated` | ubuntu |
| `test` | build + test + `check:node` | windows + ubuntu |
| `audit` | build + `audit:tui:check` | ubuntu |
| `coverage` | `test:coverage` | ubuntu |

再加一个 `all-checks-passed` 聚合 job，`needs` 以上全部。**必须用 `if: always()` 并显式断言每个依赖的 result 是 success**——否则被 skip 的 job 会被 GitHub 当成通过，聚合检查变成假绿。这是 dsh 明确处理过的坑 **[源码]**。

### K-2 保留 Windows 覆盖

`test` lane 保留双平台。理由：项目声明 Windows 11 是唯一已验证平台，而第六轮发现的 `.cmd` shim 引号问题、`test` glob 在 Linux 上「碰巧正确」两个缺陷都是平台相关的 **[源码]**。其余 lane 单平台足够。

### K-3 验收

- PR 上出现 4 个独立 check + 1 个聚合 check。
- 人为让 `static` 失败，确认 `all-checks-passed` 红且其余 lane 仍各自跑完（`fail-fast: false` 已配置）。

---

## L. 提交纪律

**现状** **[实测]**：`git log` 只有 3 个 commit，重构前工作树有 118 modified / 76 untracked / 42 deleted / 10 renamed。

**为什么这是工程问题而不是习惯问题**：没有 commit 边界，`decisions/` 无法引用「哪次变更落地了这个决策」，`git bisect` 不可用，diff review 不可能，回滚点不存在。方面 C 到 K 的所有门禁都建立在「一次变更是一个可审查单元」这个前提上。

### L-1 做法

把当前工作树按主题切成若干 commit，建议边界：

1. 方面 0 的构建修复（最小、可独立验证）
2. 本次 docs 重构 + `.gitignore` / `.gitattributes`（方面 A）
3. `AGENTS.md` 三份（方面 B）
4. 之后每个方面一个 commit

存量代码变更（`src/`、`test/` 里的 118 个修改）按第六轮 §8.1 已收口的主题切分，不要和工程化改动混在一个 commit 里。

### L-2 验收

- `git status --porcelain` 行数为 0。
- 每个 commit 单独 checkout 后 `npm run check` 通过（这一条在切分时就要验，事后补很贵）。

---

## 执行顺序

不是批次，是依赖顺序。同一个方面内部一次做完。

```
0（构建修复）
├── A（已完成）
├── B（AGENTS.md）──┐
├── C（文档门禁）──┴─→ E（门禁编排）─→ K（CI 分 lane）
├── D-2（基线校准）─→ I（拆分）─→ F（覆盖率）
├── D-1（基线 --check）
├── H（快照）
├── J（死代码，先手工清理再上工具）
└── G（生成式文档，建议延后到下次改 schema）
```

关键约束只有三条：**D-2 必须早于 I**（否则渲染变化和基线未对齐混淆）；**I 必须早于 F**（否则阈值刚设就失效）；**C 必须早于 E**（`run-gates` 要调用 `verify:docs`）。其余可以任意顺序，也可以并行。

L（提交纪律）不是最后一步——它应当在每个方面完成时执行一次。

## 完成信号

| 信号 | 判据 |
|---|---|
| Agent 能自助 | 新会话只读 `AGENTS.md` 就能正确回答「改 schema 之后还要动什么」 |
| 规范可执行 | 文档规范的每一条要么有门禁，要么明确记为「靠 review」，没有第三种状态 |
| 渲染有基线 | 改 TUI 渲染必须提交帧，diff 在 review 里可见 |
| 覆盖率不倒退 | CI 有会因覆盖率下降而失败的检查 |
| 决策有归宿 | 下一次架构改动的理由能在 `decisions/` 里找到，而不是只在聊天记录里 |
| 构建不重复 | 单次 `build` 服务全部下游门禁 |

## 反向信号

任一出现，就说明对应机制开始变成负担，应当回退而不是加码：

- 任一 `AGENTS.md` 触及字符预算，而第一反应是提高上限而不是搬走内容。
- 出现「为了过门禁而写的测试或文档」。
- 一次纯机械改动被门禁拦下超过两次。
- 门禁总数超过 10，而其中有 3 个以上从未在真实提交里报错过。
- `run-gates.mjs` 超过 200 行。

## 明确不做

判据：一条规范值得自动化，当且仅当满足其一——(a) 它已经被违反过至少一次；(b) 违反后的发现成本高于写门禁的成本；(c) 它是 Agent 高频触碰且容易猜错的约定。三者都不满足时，写进 `AGENTS.md` 作为口头约束即可。

| 不做 | 理由 |
|---|---|
| 双语 i18n 配对流水线 | dsh 每篇文档三件套（`.md` / `.zh.md` / `.i18n.yaml`）+ 配对哈希 + 翻译门禁。我们是单语中文项目，收益为零 |
| 决策记录分类子目录 | dsh 的 6 类是 542 份笔记规模下的检索需求；我们几十份，分类只会制造「这算架构还是流程」的无效讨论 |
| 冻结归档 + blob hash 密封 | 解决的是 142 份归档笔记被误编辑的问题，我们没有这个问题 |
| per-file 100% 覆盖率 | 需要 exempt-heavy 双 lane、自定义 reporter、显式豁免清单三套配套设施 |
| 全导出 JSDoc 门禁 | 单包项目内部导出多，收益远低于多包公开 API 场景 |
| 一段一行的排版门禁 | dsh 的 `verify-md-wrap` 服务于双语配对的行级 diff；中文文档无此需求 |
| 142 个门禁脚本 / 15 个 workflow / 自托管 runner | 与团队规模不匹配 |
| 真实计费 smoke 进 CI | 延续既有共识，见 `codex-smoke-gate.md` |
| 多 Product 通用抽象、报告 Markdown 渲染、状态机框架、事件总线 | 延续第四至六轮共识 |

## 附录：机制来源对照

| 本文方面 | dsh 中的对应物 | 我们的缩放比例 |
|---|---|---|
| B | 11 个 `AGENTS.md` + tier 表 | 3 个文件 |
| C-1/C-2 | `verify-md-links.ts` | 同等，加中文 slug |
| C-4 | `verify-agent-note-format.ts` + `agent-note-tree.ts` 闭集 | 去掉 class 维度 |
| C-5 | `verify-doc-budgets.ts` + `doc-budgets.manifest.json`（9 条） | 4 条，字符计数 |
| D | `gen-X.ts --check` 整文件字节比较 | 应用到 TUI 帧 |
| E | `run-gates.ts` 的 `Gate` + `needs` DAG + 14 个 mode | 3 个 mode |
| F | `vitest.config.ts` per-file 100% + `coverage-exempt.ts` | 总体阈值，实测起步 |
| G | 6 类生成目录 + region marker | 2 个生成区 |
| H | `test:snapshot` tier | 3 类模型可见文本 |
| K | `ci.yml` 的 lane 拆分 + `all-checks-passed` | 4 条 lane |
| — | lefthook pre-commit / pre-push 分层 | **不做**：本地钩子留给以后，先让 CI 有信号 |
