# 安全政策

## 报告渠道

私下报告漏洞：<https://github.com/caulif/Reprise/security/advisories/new>。不要开公开 Issue，不要把 secret、API key、完整 prompt 或本机绝对路径贴到 PR、日志或 artifact。

报告请包含：影响范围、复现所需的最少步骤、是否已有公开利用、建议的缓解。不要附带超过复现所需的密钥值。

## 受支持版本

只接受针对当前 `main` 与已发布 npm 包（若有）的报告。分叉、过期 tag 和未发布本地改动不在支持范围。

## 响应时限

维护者目标是 7 天内确认收到，并在确认后给出是否受理、临时缓解和预计修复窗口。单人维护，时限是目标不是合同。

## 修复、回归与公告

修复必须带能失败的回归（测试、门禁或文档自检，按改动面选择）。凭据与 artifact 规则见[产品定义 · 凭据](./product/overview.md#13-凭据)。公开公告走 GitHub Security Advisory；需要用户可见说明时写入 [`CHANGELOG.md`](./CHANGELOG.md)。
