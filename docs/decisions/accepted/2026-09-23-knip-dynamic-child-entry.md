# 决策：将动态启动的测试子进程列为 Knip 精确入口

状态：accepted

延续[门禁反向用例要求](./2026-08-15-gate-reverse-tests.md)。

## 问题

`test/application/control-ipc.test.ts` 用拼接出的文件路径，通过 `spawn(process.execPath, [childPath, ...])` 启动 `test/support/control-owner-child.ts` 编译后的子进程。这个运行时路径不是静态 `import`，Knip 的依赖图因此把仍在使用的子进程源码误报为未使用文件。删除该文件会破坏控制端点的跨进程测试。

## 决定

在 `knip.json` 的 `entry` 中只登记 `test/support/control-owner-child.ts!`。此项说明该文件由测试进程直接启动，同时让它继续处于 Knip 的项目分析范围；其他 `test/support` 文件仍须经通常的未使用文件检查。保持 `test/**/*.test.ts` 作为测试入口，不调整 Knip 的导出规则或忽略范围。

## 备选方案

**忽略整个 `test/support/**`。** 会隐藏真正失去调用方的辅助文件，使未使用文件门禁失效。

**在测试中静态导入子进程文件。** 导入会在父测试进程执行其顶层逻辑，改变跨进程测试的运行边界。

**删除被误报的文件。** 动态启动路径仍需要它，测试会在启动时失败。

## 影响

Knip 对这一条动态入口不再误报；精确 entry 以外的测试辅助文件仍按原规则检查。今后若更改子进程路径，需同步核对测试调用与 Knip entry，不能用宽泛忽略掩盖路径漂移。

## 验证

`test/core/knip-dynamic-entry.test.ts` 读取仓库的实际 entry，在临时项目运行真实 Knip：保留该入口时通过，移除后必须因子进程文件未使用而失败。`npm run knip` 检查完整项目。
