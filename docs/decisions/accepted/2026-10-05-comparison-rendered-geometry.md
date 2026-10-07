# 决策：Comparison 的有界渲染几何观测

状态：accepted

## 问题

真实 Comparison 审阅能读到完整源码，却仍把局部算法目标当成最终绘制端点；独立来源审查和更短报告并未消除错误。重算目标公式不能检验下游 SVG/CSS 变换。扩展既有 `render_artifact`，由 Host 在实际渲染页面中收集有界几何观测；不引入模型编写的浏览器脚本，不增加候选 Runtime 能力，也不把截图设为所有任务的必选证据。

## 决定

- 可选 `geometryQueries` 包含最多 8 个唯一名称的查询：固定 `svg_geometry` 或 `dom_rect`，selector 最长 160 字符。模型只能选择元素和观测类型，不能传入表达式或 JavaScript。请求与外部 CDP 返回经 core schema 检查。
- 查询必须唯一匹配；缺失、歧义、无效 selector、不支持的元素或不可取得的几何返回明确状态，不选第一个、不补零。SVG line/path 收集自然起终点，circle/ellipse 收集中心与两个半径点；路径自然终点不保证代表任务中的语义端点。
- 固定采集器在独立 execution world 运行，避免产物脚本覆盖测量 API；创建失败不能降级到 main world。SVG 局部点通过实际 `getScreenCTM` 转为 `viewport_css_pixels`，DOM bounds 使用同一坐标域。观测不证明没有遮挡、完整可见或视觉美观。
- 返回每帧独立采集窗口 `startedAtMs` / `finishedAtMs`，PNG 随后采集，二者并非同一瞬间。绑定原查询身份、顺序、点位名称及变换映射；数值有限且有界，每个 sample 最多 16 KiB UTF-8。非法外部结果按失败处理，不伪造成功。
- 几何进入已有 `renderedCheck` 与工具结果事件审计，并由草稿检查共享来源/hash、viewport、采样与实际观测事实；不建立第二份权威持久化文件。登记媒体失败或相同 PNG 不抹掉已经发生的数值观测。
- 纯文本模型可读几何证据，但不因此获得图片查看权限；保留现有图片交付、bundle 网络隔离、取消、预算与 provenance 边界。旧调用不带查询时保持原行为。

## 备选方案

**只改提示或增加审阅时间。** 原例已经完整读取关键源码，仍错误推断输出链；增加时间不补充独立观测。也不采用本例标准答案、任意页面脚本或更换模型来掩盖现有配置的失败。

## 影响

受控数值证据仍需 Agent 判断元素角色及任务意义；少量状态不保证全周期正确。提示优先核实际输出链，并把观测范围写进决定性结论。新增可选工具字段与审计事实，不迁移旧磁盘记录，不修改 CandidateRun/Runtime 状态及模型图片权限。

## 验证

自动化须反向拒绝注入字段、超额请求、非法数值、身份/时间/点位不匹配和超字节结果；合成真实渲染检验局部目标相同但下游变换偏移、嵌套坐标以及产物覆盖测量 API 的场景。实现与门禁通过后，以同模型、同原始输入的新冻结版本重新进行真实语义验收；旧失败及 stop 标记保留。

事实归宿：[证据与 Comparison](../../architecture/evidence-and-comparison.md)。沿用[受控渲染](2026-09-19-controlled-artifact-render.md)与[原生图片权限](2026-09-30-comparison-native-image-pipeline.md)。
