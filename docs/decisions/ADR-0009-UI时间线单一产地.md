# ADR-0009 UI 信息架构：时间线单一产地与分层约束

- 日期：2026-10-31
- 状态：✅ 已验证（typecheck / 359+ 用例 / gen-check / build / 真机截图）
- 关联：ADR-0007（三体隔离）、Loopsoar 分层规则（contracts→core→services→shell→ui）

## 背景
为把 slime 的会话时间线体验完整搬到 Loopsoar，UI 侧新增了时间线、工具卡、规划卡、产物卡、diff 等大量渲染。
slime 的同一块界面历史上出现过「同一份状态下多套渲染实现、旧路径没删、样式互相覆盖」的问题
（如旧回复渲染与新时间线并存、失败样式两处判定漂移），最终难以排障。
Loopsoar 的硬约束是：**架构干净、单一产地、易于修复排障，禁止为兼容而堆叠第二套实现**。

## 决策
1. **时间线是会话轨迹的唯一数据源**
   - `chat:stream:*` 事件在 App 中被累积成 `TimelineStep[]`（think/body/tool/plan/todo/steer）；
   - 渲染只消费这一份数据；不再维护平行的 `reasoning` / `tools` / `plan` / `announces` 字段。
   - 旧版 `ToolCard.tsx` / `PlanCard.tsx` 与回退渲染已删除（本次提交）。旧会话没有 timeline 就不渲染思考卡——
     **宁可缺功能，不保留第二套渲染路径**。
2. **分层职责固定**
   - 纯逻辑：`timeline.ts`（节点/合并/分组/分类）、`chatStreamState.ts`（事件→消息状态，纯函数）、
     `artifacts.ts`（diff 编解码/行 diff/产物与引用收集）、`attachments.ts`；
   - 展示：`Markdown.tsx`（唯一富文本渲染器）、`TimelineView.tsx`（时间线）、
     `ArtifactPanels.tsx`（产物/参考/网址面板）、`DiffBlock.tsx`（diff 块）；
   - 编排：`App.tsx` 只做事件→时间线、布局、回调接线，不再内嵌工具/规划/播报的第二种渲染。
3. **契约单产地**
   - 时间线持久化走 `packages/contracts` 的 `TimelineStepSchema` + `chat:saveTimeline`；
   - 所有 IPC 必须 `pnpm gen` 生成、`pnpm check` 逐字节校验；UI 不直接拼事件名。
4. **禁止迁移/兼容双轨**
   - 数据结构变化时直接迁移旧数据或明确丢弃，不写「旧格式 if / 新格式 else」两套渲染；
   - 事件处理只在一处（App 的 chat 事件 effect），组件不得自行订阅同类事件。
5. **规模红线**
   - 单个 UI 源文件 > 1200 行必须拆分；一次改动引入的新文件必须有明确单一职责；
   - 纯逻辑必须可被 vitest 直接测（不 import React/electron/shell）。
6. **验收门禁**
   - `pnpm -r typecheck`、`pnpm gen && pnpm check`、`pnpm build`、`pnpm test`；
   - 关键视觉变化必须有真机 E2E 截图（docs/screenshots）。

## 理由
- 时间线渲染涉及「思考/正文/工具/规划/播报/引导」六类节点，若数据与渲染多处并存，任何一处修复都会漂移；
- 排障时只需问两个问题：事件是否正确进入 timeline？渲染是否正确消费 timeline？
- slime 的混乱主要来自历史兼容分支与多实现并存，Loopsoar 现在体量小，必须先把规则钉死。

## 替代方案
- **保留旧渲染做回退**：否——旧会话恢复只需「无 timeline 则不显示思考卡」，回退代码是未来屎山的种子；
- **把时间线状态放进全局 store**：当前只有单一会话流式源，React state + 事件 effect 足够；
  未来多会话并行流式时再引入 store，并保持「事件 → store → 展示」单向。

## 验证方式
- `tests/ui/timeline.spec.ts`（节点/分组/规划/播报）、`tests/ui/artifacts.spec.ts`（diff/产物/引用）、
  `tests/core/sandbox-workspace.spec.ts`（相对路径工作区判定，file_write 产物链路的前置修复）；
- 真机：`gui-55-timeline-restored.png`（重启恢复）、`gui-56-diff-products.png`（产物/diff 卡）。

## 回退条件
若未来引入多会话并行流式/插件自定义消息渲染，需要重新评估；回退时必须保持：
「每个数据只有一份状态、每个状态只有一条渲染路径」。

## 复核时间
v1 发布前；每次新增会话渲染类型时复核本 ADR。
