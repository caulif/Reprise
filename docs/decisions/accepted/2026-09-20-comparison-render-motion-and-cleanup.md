# 决策：Comparison 渲染运动证明与清理

状态：accepted

## 问题

Comparison `render_artifact` may register multi-frame visual evidence only when
at least two sampled PNG content hashes differ. Identical repeated frames are
returned as `motion_not_proven` and do not mutate the evidence catalog. This
keeps a renderer or fixture that ignores sample time from being presented as
animation evidence.

Document entries are resolved and contained before the bundle server starts;
leaf symlinks and resolved paths outside the bundle are rejected. Browser
cleanup terminates the complete Windows process tree through `taskkill /T /F`
and removes the temporary profile after the child has settled.

## 决定

The renderer and tool enforce these boundaries before evidence publication.

## 备选方案

**允许重复帧继续注册。** This would let a broken or static renderer claim
animation evidence and was rejected.

**只杀浏览器父进程。** This can leave renderer children alive on Windows and
was rejected.

## 影响

Static screenshots remain valid for single-frame previews. Multi-frame callers
must provide a fixture whose rendered content changes over time, and the
failure is deterministic before any media registration. Cancellation and
browser startup failures leave no intended catalog entries and do not use a
user browser profile.

## 验证

- `test/application/comparison-render-tools.test.ts` proves static repeated
  frames are rejected without catalog mutation.
- `test/application/artifact-renderer.test.ts` covers invalid document entry
  handling and the existing cancellation/path isolation cases.
- `test/application/comparison-acceptance-matrix.test.ts` keeps V2/P2/S1
  owned only when their owning suites are present.
