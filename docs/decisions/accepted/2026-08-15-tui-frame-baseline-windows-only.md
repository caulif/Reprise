# 决策：TUI 帧基线只在 Windows runner 上比对

状态：accepted

## 问题

TUI 按宿主平台渲染：PowerShell 提示语、盘符 cwd、反斜杠路径。帧基线是 Windows 渲染的产物。把 audit lane 放在 `ubuntu-latest` 上，同一份基线会因为 shell 语法和路径分隔符分叉，门禁红的是平台差异而不是渲染回归。

## 决定

CI 的 `audit` lane 跑在 `windows-latest`。帧基线是平台相关产物，只在已验证平台上做逐字节比对。`test` lane 的 Windows / Ubuntu 矩阵保留：它抓的是跨平台行为缺陷，不是像素级文案。

## 备选方案

**在生成器里按平台注入 shell 语法、cwd 和分隔符。** 每多一个平台差异就要加一处注入。注入面会铺开，而基线仍然只代表 Windows 产品。

**为 Linux 另存一套帧基线。** 双倍维护，且 Linux 不是已验证的用户平台；两套基线会让「改了渲染」变成「改了哪一套」。

**audit 改成忽略平台相关行。** 忽略清单会越来越长，最终把比对变成启发式，失去逐字节基线的意义。

## 影响

- Linux CI 不再因为 `$env:` / `export` 或路径分隔符让 audit 变红。
- 改 TUI 渲染的人必须在 Windows 上重新生成帧，或等 Windows audit lane 给出 diff。
- 跨平台逻辑回归仍由 `test` 双平台矩阵负责。

## 验证

- `.github/workflows/check.yml` 里 `audit.runs-on` 为 `windows-latest`。
- `test` job 仍使用 `windows-latest` 与 `ubuntu-latest` 矩阵。
