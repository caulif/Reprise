# Recovery Agent 模型失败分类与重试边界

- 日期：2026-08-19
- 状态：accepted
- 范围：Pi Agent Host 的失败分类、工具失败归因和 Recovery retry policy

## 决策

模型调用失败除了既有 `code` 外，Host 记录脱敏的 `kind`：

- `authentication`：认证、权限或无效密钥；
- `rate_limited`：限流、配额或 429；
- `transient_network`：连接、传输或临时网络错误；
- `tool`：注册工具执行失败；
- `timeout`、`cancelled`、`protocol`、`unknown`：分别表示超时、取消、协议/输出问题和无法安全归类的错误。

Recovery 只对 timeout、rate-limited、transient-network 以及未带分类的旧注入端口结果执行一次有界重试。真实 Host 已分类的 authentication、tool、protocol 和 unknown 不自动重试，避免把不可恢复错误误判为瞬时故障；无论分类如何，forensics、candidate 和失败审计都继续保留。

## 安全边界

分类只使用错误类型、错误码和有限错误消息模式，不把凭据、完整 provider 响应或源路径写入 artifact。未知错误保持 `unknown`，不得升级为可重试类别。工具错误通过 Host-owned wrapper 归因，不得因为模型请求失败而伪造工具成功。

## 验证

- Agent Host 反向测试覆盖认证、网络、未知和工具失败；
- 原有模型失败的一次有界重试、超时、协议错误、隐私阻断和 Recovery forensics fallback 测试继续通过；
- 全量 `npm run check` 作为门禁验证。
