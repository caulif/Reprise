# 决策：查找编辑与恢复快照由单个局部对象持有

状态：accepted

## 问题

查找是否开启、query、cursor 和退出时恢复的位置散落在 IntakeTui 上；输入、运行完成和导航需要分别重置四项。局部查找状态依赖整个控制器，容易漏清理恢复快照，也不便单独验证输入隔离。

## 决定

[CanvasFind](../../../src/tui/canvas-find.ts) 只拥有既有查找编辑状态和 FindRestoreSnapshot。键盘解析继续委托原 dispatchCanvasInput；控制器转发返回动作，并在需要时提供一份普通位置快照。reset 一次清除全部局部状态，且只返回一次此前快照。

局部对象不接收 IntakeTui、ControllerHandle 或它们的大型 Pick，不读取磁盘、Runtime、实验结果、当前页面或模型状态。控制器仍负责选中行、fold、follow 与恢复位置；页面只消费只读查找快照。查找不改变 generation，导航和异步请求仍使用已有 generation/request token。

本批只收口查找，不迁移 composer、配置草稿、发现请求、History 或运行状态。

## 备选方案

**把更多控制器函数搬到另一个接收 this 的文件。** 文件虽然变短，四项状态和重置责任仍然分散，依赖边界没有缩小。

**让局部查找对象直接拥有整个 timeline 与导航。** 会引入第二个选中位置/页面拥有者，扩大需要协调的状态，超出这次局部职责收口。

## 影响

IntakeTui 和控制器接口用一个 CanvasFind 取代四个可变字段；运行完成、开始运行和回首页复用同一 reset。现有按键、Unicode 编辑、滚动、fold、鼠标选择及执行状态不变，不修改事件、on-disk、模型输入或应用层接口。当前边界见[架构总览](../../architecture/overview.md)。

## 验证

覆盖 Unicode 粘贴/光标删除、被覆盖层阻塞时不改查询、实例隔离、一次性位置恢复；实际控制器输入在新输出追加后退出查找仍恢复原 anchor/offset，真实 IntakeTui 回首页清空查找且保留 generation 失效行为。既有输入、workflow 取消、查找、滚动、fold 和帧检查继续运行；不调用真实模型或 Runtime。
