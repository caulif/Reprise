# 发布清单

发布 npm 包前按本清单执行。真实 Runtime smoke 不在默认清单内，除非本次发布改了 Pack/协议并已显式 opt-in。

## 版本与说明

- [ ] `package.json` 的 `version` 与 git tag 一致（SemVer）。
- [ ] [`CHANGELOG.md`](./CHANGELOG.md) 的 Unreleased 已归入该版本；破坏性 on-disk/事件变更写了迁移、兼容窗口和回滚。
- [ ] 需要的 `docs/decisions/` 已 landed。

## 验证

- [ ] 干净检出：`npm ci`
- [ ] `npm run check`
- [ ] `node scripts/verify-pack.mjs`（在 `build` 之后；包内含 `dist/src/cli/main.js` 与清单允许的元数据，且无源码/docs）
- [ ] `node scripts/verify-audit.mjs`
- [ ] `node scripts/verify-secrets.mjs`
- [ ] 已验证平台：Windows 11、Node `>=22.19.0`

## 发布与回滚

- [ ] `npm publish --access public --dry-run` 后正式发布（registry 若支持 provenance 则打开）。npmjs 上已有无关同名包 `reprise@1.1.0`；本仓库当前是 `0.1.0` 且尚无 git tag。默认 dry-run 会因不能把低于 1.1.0 的版本打成 `latest` 而失败。在改名或拿到该名字之前，dry-run 必须带显式 `--tag`，且不得把 registry 上的 1.x 当作本 harness 的上一版本来安装。
- [ ] tag `vX.Y.Z` 已推送。
- [ ] 回滚：对故障版本 `npm deprecate reprise@X.Y.Z "reason"`，并验证 `npm install reprise@<previous>` 仍能读取当前数据目录（或文档中的迁移回退步骤）。本 harness 尚无上一发布版时，用当前 tarball 读取 `schemaVersion` 1 的 `events.jsonl`；打不开的 journal 必须保留原文件并失败，不得原地改写。
- [ ] 事故写 [`postmortem-template.md`](./postmortem-template.md)，并挂上修复 commit 与回归测试。
