# 决策：配置编辑与测试会话由局部对象持有

状态：accepted

## 问题

配置 draft、编辑光标、待确认操作、测试状态和 busy 散落在 IntakeTui。输入 reducer 的结果逐项写回宿主；打开、离开配置页和回首页分别重置子集，重置与异步测试的归属容易分离。

## 决定

[ConfigSession](../../../src/tui/config-session.ts) 只拥有编辑/测试局部状态、draftVersion、dirty cache 和同进程 request ticket，外部读取只读快照。键盘逻辑继续复用 handleConfigInput。reset 一次清空编辑、测试和 busy，同时使旧 ticket 失效；只有当前 ticket 能退 busy 或安装测试结果，草稿版本变化使结果为 stale。

保存、真实探测、PiModels、providers/models、保存后的 modelConfig、返回页面、overlay 与 navigation generation 继续由 adapter 拥有。旧 generation 提交 guard 仍保留；request ticket 只约束局部 busy/测试归属，不决定导航，不取消真实请求，也不建立另一套页面 generation。owner 不接收整个控制器或 TUI，不读取或写入文件，不调用模型。

## 备选方案

**只移动接收整个 this 的 reset 函数。** 宿主仍可直接改写字段，旧请求与新编辑会话的归属仍散落。

**把配置保存和导航也放入 owner。** 会扩大状态对象依赖，建立重复的副作用/页面生命周期，本批只收口编辑与测试会话。

## 影响

页面、运行前配置判断和 audit helper 消费同一局部快照，不新增兼容 getter。回首页也清理隐藏的测试结果与 busy。保存成功仅清空测试结果，不证明连接通过；缺少凭据仍在发请求前拒绝，不标记测试失败。配置文件、凭据存储、模型输入和运行契约不变。

## 验证

保留真实 app 的草稿变化后 stale、离开/重新打开、旧 probe 不清新 busy、返回 inspection 与缺凭据拒绝测试回归。新增跨实例/弃置 ticket 隔离、原 editor 修改 draft 的版本保护、真实回首页重置与 navigation generation 回归。原 54 帧继续 byte compare，不更新 golden 来替代目标状态；不调用真实模型或 Runtime。
