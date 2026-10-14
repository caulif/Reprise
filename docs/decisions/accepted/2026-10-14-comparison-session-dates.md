# 决策：Comparison 双侧会话日期

状态：accepted

## 问题

报告的双侧模型标签不能区分历史会话与本次运行的日期。导入、报告生成及文件修改时间都不能代表原会话日期；按查看机器时区格式化又可能让同一报告跨日变化。

## 决定

Host 在双侧模型名旁显示 UTC 日期。历史侧使用冻结 TaskCase 中的 historyStartedAt 与历史事件顶层 timestamp 的最早合法时间，表示可取得的最早会话记录，不声称恢复了缺失的真正起点。当前侧优先使用 manifest.startedAt，缺失或非法时使用 attempt.createdAt。复用已有严格 ISO 时间校验，不把无时区或非法日历时间当作有效日期。

新增可选 reportFacts.sessionDates，双侧日期也分别可选；通过现有 schema 校验、comparison.requested 输入 artifact 和 briefing 保存并恢复，不新增独立模型输入渠道。Host 生成标签并沿用 Host 区篡改校验，Agent 不填写日期。旧 facts 缺字段时显示日期未知，旧已发布 HTML 不迁移、不原地改写。

## 备选方案

**使用导入时间或报告生成时间。** 容易获得，但会把导入、重试或重新比较误显示为会话日期。

**按查看机器的本地时区显示。** 更符合部分用户习惯，但不利于冻结报告一致重放；选择显式标注 UTC。

## 影响

仅增加可选字段，保留现有报告格式和旧 facts 读取。没有真实时间的历史数据仍未知；当前运行未产生 manifest 时日期代表 attempt 创建日。无需迁移，回滚可撤销提交，已有旧报告保持原样。

## 验证

回归检查两侧不同日期、跨时区跨日、无时区和非法日历时间、history-only 元数据、manifest 优先级、缺失日期及旧 schema 兼容，验证冻结 facts 的显示和 Host 日期篡改检测。中英文报告快照随渲染器更新，不调用真实 Runtime 或付费模型。

现行规则见[证据与对照](../../architecture/evidence-and-comparison.md)。
