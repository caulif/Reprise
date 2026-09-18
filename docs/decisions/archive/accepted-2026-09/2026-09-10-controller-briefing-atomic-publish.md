# 决策：Controller briefing 原子发布

状态：accepted

## 问题

一次 settled turn 若边写 turn 文件边覆盖 `THIS-TURN.txt` 与 `current-user-view.md`，中断会让 Controller 看到混版本入口。

## 决定

先写不可变 turn 目录（`stageSettledTurnBriefing`），再把活入口写入 `.publish/` 并校验，最后才用 `writeAtomic` 替换 `current-user-view.md`、`THIS-TURN.txt`、`INDEX.md` 并写 manifest。中断发生在活入口替换之前时，Controller 继续看到上一份完整视图。

## 备选方案

**边写边覆盖活入口。** 指针可能指向尚未写完的 turn。

## 影响

`writeSettledTurnBriefing` 是完整发布；测试可只调用 `stageSettledTurnBriefing`。

## 验证

`test/application/controller-briefing.test.ts` 覆盖只 stage 不发布时活入口仍是 opening 视图。

