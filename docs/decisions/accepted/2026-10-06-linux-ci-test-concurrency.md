# 决策：Linux CI 显式限制测试文件并发

状态：accepted

后续验证：2 并发的 Ubuntu 普通测试通过，coverage 的同一真实预览仍超时。coverage 因而使用 1 并发，避免覆盖率采集时不同测试进程同时争用资源；生产超时及阈值不变。具体 Chrome/DBus 或 CPU 根因未获证明，新 CI 必须重新验证。

## 问题

Ubuntu CI 的真实浏览器测试仍在生产 15 秒启动边界内失败，同一作业在测试结束后使用同一 `/opt/google/chrome/chrome` 的独立 smoke 成功，Chrome 154 启动约 371 毫秒。这支持失败与并行测试负载有关，不证明具体 CPU、内存或调度根因，也不支持先前 snap 启动器假说。不能因此放宽产品超时或跳过真实浏览器断言。

## 决定

测试临时目录守卫增加显式 `--concurrency N`，只接受安全的正整数并传给 Node `--test-concurrency=N`。省略时保持 Node 原默认。共享 parser 自测拒绝缺值、零、负数、小数、非数值、不安全整数、重复选项及未知选项；非法配置在启动测试前失败。

`run-gates` 将该参数只转发给 test gate，未包含 test 的模式拒绝该配置。Linux CI 的 test lane 显式设置 2、coverage lane 设置 1；Windows 和 macOS 保持原默认。测试失败退出码、临时目录检查、覆盖率阈值和总门禁依赖关系保持原规则。

## 备选方案

**增加生产浏览器启动超时或放宽真实 fixture。** 改变用户可见失败边界且掩盖 CI 调度问题，不采用。

**全平台默认串行或通过隐式环境变量限制。** 扩大已验证平台的执行变化或隐藏资源配置，不采用；只在 Linux CI 显式指定并发。

## 影响

Linux CI 可能运行更久，仍受原作业超时约束。并发设置是资源调度选择，不保证消除全部浏览器启动故障；是否解决当前失败须由新 head 的真实 Ubuntu CI 结果确认。

## 验证

guard 的独立 `--self-test` 执行正向与反向 parser 用例；`run-gates --self-test` 验证参数仅转发给 test、其他 gate 与省略默认不变。真实非法 CLI 必须非零退出，不能启动测试。后续 Linux CI 保留真实浏览器 fixture、覆盖率与 all-checks-passed 聚合门禁，独立 smoke 仅提供诊断。
