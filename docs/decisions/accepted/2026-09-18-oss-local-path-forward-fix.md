# 决策：开源前本地路径只向前修

状态：accepted

## 问题

`scripts/claude-real-e2e.ts` 曾硬编码维护者本机 Claude session 绝对路径。历史提交可能已在公开历史中暴露类似路径；重写 Git 历史会伤害协作与审计链。

## 决定

- 真实 session 路径只经环境变量 `REPRISE_CLAUDE_REAL_E2E_SESSION` 注入；未设置时脚本打印用法并以非零退出。
- `verify-secrets` 在 `src/`、`scripts/`、`test/` 拒绝 Windows `C:\Users\...` 与 Unix `/Users/...`、`/home/...` 形态的本机绝对路径；测试内已存在的合成用户名（如 `demo`、`RUNNER~1`）列入白名单。
- 不执行 filter-repo、force-push 或任何历史改写；门禁防止再次提交。

## 备选方案

**Git 历史改写（filter-repo / BFG）。** 可抹去已公开的硬编码路径，但破坏 fork/clone 的提交链，且无法保证所有镜像已同步。

**仅删文件、不加门禁。** 无法阻止后续脚本或测试再次写入本机路径。

## 影响

- 维护者本地跑 `smoke:claude:e2e` 须先设置 `REPRISE_CLAUDE_REAL_E2E_SESSION`。
- `verify-secrets` 在 `src/`、`scripts/`、`test/` 增加绝对路径规则；合成测试用户名须登记白名单。
- 历史暴露路径不在本 PR 范围内处理；读者若关心须自行查阅旧提交。

## 验证

- `node scripts/verify-secrets.mjs` 自检含合成路径放行与真实形态路径拒绝的反向用例。
- 跟踪文件中不再出现该硬编码 session 路径。
