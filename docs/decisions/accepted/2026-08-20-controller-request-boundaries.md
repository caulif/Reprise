# Controller 请求事实与边界

## 决策

每轮 Controller 请求由 Host 生成 requestId，并记录 `controller.requested` 事件。事件只保存去标识化的观察快照、预算、回放事实、本轮 evidence catalog 与输入 digest，不保存完整 Prompt、凭据或模型输出。`controller.observation_read` 记录该 `requestId` 下成功的观察读取及其属于当前 run 的 event refs。`reconstructControllerRequest` 用事件日志（及已保存 artifacts）离线校验 digest，并把该 `requestId` 的观察读取折入 catalog；不重读 live workspace。

evidence catalog 是新请求的必填 Host 事实：初始登记当前 run 的 current/trajectory refs；只有 `details.runId` 等于当前 run 的成功 `read_observation` 才登记新 ref。决定只能引用本轮 catalog 中属于当前 run 的 refs；未知、缺失或跨 run 的 ref 不能成为 send/done。

同一 run 同时最多一个 Controller 请求。取消按 `requestId` 在解码前提弃迟到模型结果，因此不会把迟到 send/done 提交给 CandidateRun。send 消息拒绝空白、超过 65,536 字节或异常控制字符；send/done 状态变化仍由 CandidateRun 负责。

## 范围

本决策不改变 Prompt、模型选择、send/done 协议或真实 Runtime opt-in；不引入语义进展判断、事件总线或多 Controller Agent。
