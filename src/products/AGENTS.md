# AGENTS.md — Product Pack

改适配前读[平台与 Pack 规范](../../docs/architecture/platform-and-packs.md)；历史读取、Projection 与 Playbook 的公共端口见 [contract.ts](contract.ts)，候选控制端口见 [core/runtime.ts](../core/runtime.ts)。

装配与加载诊断从 [registry.ts](registry.ts) 进入，内置注册从 [index.ts](index.ts) 进入。恢复知识与 Environment 的分工见[环境专题](../../docs/architecture/environment.md)，不要把目标迁移安排当作当前接口。
