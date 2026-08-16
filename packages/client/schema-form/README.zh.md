# @deepseek-ai/dsh-client-schema-form

[English](README.md) | 中文

面向 settings 编辑器的 schema／草稿模型层。wire 侧的 `settings.describe` 携带每个 namespace 的序列化 schemastery schema（`schema.toJSON()` 的 ref 封装）；`rehydrateSchema` 用 `new Schema(json)` 将其中的结构规则还原（rehydrate）为活的校验器。序列化的 transform 回调会变成恒等变换，而不是在浏览器中执行的代码。草稿写入时，Host 仍使用完整 schema 作最终判定。编辑器各自渲染自己的控件（Models 页围绕它在此探测到的字段手写自己的卡片）；该包不含任何 React，也不做任何渲染。

## 约定

编辑的单元是**用户分节草稿**：一个以不可变方式编辑的普通对象（`setPath` 会物化中间对象，`deletePath` 即逐字段重置——去掉该键，解析值便回退到组合 base 与 schema 默认值）。字段只要出现在草稿中就被标记为**已覆盖**（`hasPath`）——判定采用存在性语义而非值比较，与 settings seam 的分层方式严格对应。`nodeAtPath` 解析可配置提供方目录 `settingsPath` 所寻址的 schema 节点（object 属性按名称解析，dict 条目经由 `inner`），编辑器因此可以在决定渲染什么之前，先探测某提供方的 profile 携带哪些字段（及其 `meta.role`）；无法解析的路径返回 `undefined`，调用方因此会明确进入降级路径，而不是渲染出错误的子树。`validateDraft(schema, draft)` 运行惰性的结构校验器并返回其失败消息，页面因此可以在写入前捕获普通的类型与范围错误。settings Host 会在接受写入前应用原始 schema，包括 transform 与 owner validation。

## 模型体验

无。该包支撑的是浏览器配置编辑器；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **客户端校验省略 transform 行为**——序列化的 transform 回调属于可执行源码，因此 renderer 会将其替换成恒等变换。若 schema 回调会改变或拒绝值，客户端校验可能比 Host 更宽松；最终写入会报告 Host 的权威失败。
- **校验是草稿级的，而非逐字段**——`validateDraft` 报告 schemastery 的第一条失败消息及其 `$.path`；它不会把错误映射到各个控件。
- **没有通用渲染器**——消费方在这些辅助函数上构建功能专用表单。[Web 配置面 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-30-web-config-plane.md) 记录该权衡。
