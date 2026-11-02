# Loopsoar「柔和无框」主题设计规范（v1，2026-11-03）

> 目标：从「全是 1px 条条框框的板正界面」改为「靠明度分层、圆角与留白呼吸、克制动效」的现代桌面 AI 浏览器观感。
> 参考：用户指定 `D:\pilot project`（slime，只读参考：双主题 token、0.45–0.5s collapse 动画、浮窗/折叠侧栏、无边框卡片）＋ 当前主流无边框深色界面语言（Linear / Arc / Raycast 类）。
> 约束：旧观感不删除 → 作为 `classic` 主题保留；新主题 `soft` 为默认。

## 1. 设计原则

1. **分层靠明度，不靠描边**：取消 1px 实线边框（改为 `rgba(255,255,255,0.05~0.08)` 的极低对比或完全透明），层次由 3 级表面色 + 柔和阴影 + 8px 间距建立。
2. **圆角更大**：卡片 12–14px，按钮/输入 8–10px，紧凑 chip 999px；不再出现直角面板。
3. **留白增加**：工具条、侧栏、消息之间的垂直间距放宽 10–20%；侧栏去掉多余分隔线。
4. **动效克制且统一**：交互 120–180ms；布局/面板 280–450ms；缓动 `cubic-bezier(0.2, 0, 0.2, 1)`（decelerate）；遵循 `prefers-reduced-motion` 与设置里的动效强度。
5. **悬停有回应但无跳动**：hover 只改背景色/亮度（不位移），active 轻微 scale(0.98)。
6. **毛玻璃仅限小面积**：只用于浮层/菜单（`backdrop-filter: blur(14px)`），**禁止**用于含原生网页视图的祖先（Electron 已知命中测试失效雷区，pilot 项目有同样教训）。

## 2. 色彩 token（CSS 变量，UI 全部经 `BRAND` 引用）

### soft（默认，近黑蓝灰，低对比）
| token | 值 | 用途 |
|---|---|---|
| --ls-bg | `#0d0f13` | 应用底 |
| --ls-surface | `#14171c` | 面板/侧栏底 |
| --ls-surface-raised | `#191d24` | 卡片/输入/工具条 |
| --ls-surface-hover | `#20252e` | hover 面 |
| --ls-border | `rgba(255,255,255,0.06)` | 细描边（可视为无） |
| --ls-border-strong | `rgba(255,255,255,0.10)` | 需要边界时 |
| --ls-text | `#ece9e2` | 主文字 |
| --ls-text-muted | `#a09b93` | 次文字 |
| --ls-text-faint | `#6d6862` | 弱文字 |
| --ls-accent | `#d98a4f` | 品牌赭石（hover 亮档） |
| --ls-accent-soft | `rgba(217,138,79,0.14)` | 选中底 |
| --ls-teal | `#6ee7d0` | 成功/在线 |
| --ls-danger | `#f87171` | 错误 |
| --ls-radius-sm/md/lg | 8 / 12 / 16px | 圆角 |
| --ls-shadow-card | `0 8px 32px rgba(0,0,0,0.35)` | 浮起卡片 |
| --ls-shadow-float | `0 24px 64px rgba(0,0,0,0.55)` | 浮窗/菜单 |

### classic（旧观感，原值）
沿用现有 `#111318 / #17191e / #15171c / #262a31 / #333842 / #f4efe6 / #a8a29a / #6f6a63 / #c8763c / #5eead4 / #f87171`。

## 3. 结构观感

- **顶栏/工具条**：去底边线；与内容用 4–6px 明度差 + `backdrop-filter`（仅 DOM 区域）区分；按钮 hover 显示圆角浅底。
- **右侧会话栏**：改为「浮动卡片」观感（8px 外边距、16px 圆角、柔和阴影、无左边线）；会话列表项去掉边框，仅用背景/圆角区分选中；分组标题更小更淡。
- **折叠/小窗**：
  - collapsed：48px 竖条，仅 Agent 图标 + 展开按钮 + 未读点；宽度过渡 320ms；内容淡出（不能瞬间卸载，用 opacity + width 同时过渡）。
  - float（小窗）：340px 浮动卡片，四周留 8px，圆角 16px，阴影 `--ls-shadow-float`，工具条圆角胶囊化。
- **底部终端面板**：从窗口最底部整宽拉起（VS Code 风格），顶部 1px 分隔改为 8px 明度差 + 圆角顶边；高度过渡 240ms；与内容区之间无硬边。
- **消息区**：去掉气泡外框，改为「无边框内容块 + 左侧 2px 强调条（仅 assistant）或不加」；代码块保留微底与圆角。

## 4. 动效规范（衔接动画）

| 场景 | 时长/缓动 |
|---|---|
| hover/active | 120ms / 80ms，`ease-out` |
| 主题切换 | 200ms 颜色过渡（不加位移） |
| 侧栏收起/展开/小窗 | 320ms `cubic-bezier(0.2,0,0.2,1)`，宽度与透明度同步 |
| 终端面板拉起/收起 | 240ms 同上，高度过渡 |
| 弹层进出 | 140ms 缩放 0.98→1 + 透明度（`prefers-reduced-motion` 关闭位移） |

**关键实现约束（来自 pilot 项目的教训）**：
- 折叠内容必须**常驻 DOM**（不要条件渲染），否则没有第二帧可插值 → 动画生硬；
- 用 `grid-template-rows: 0fr↔1fr` 或显式高度做可插值过渡，禁止写死 `max-height`；
- 收起结束时才设置 `visibility: hidden / content-visibility: hidden`（延迟 = 时长 + 120ms），否则末帧跳变；
- 给含原生网页视图的区域**不要**加 `backdrop-filter`/大范围 `filter`（命中测试失效）。

## 5. 主题选择

- 偏好 `theme: "soft" | "classic"`（默认 `soft`）；设置 → 外观 提供分段选择器，切换即时生效（`document.documentElement.dataset.theme`）。
- `theme.ts` 的 `BRAND` 全部改为 `var(--ls-…)` 引用（带原值 fallback），使内联样式自动跟随主题；硬编码的中性色统一收敛到 token。

## 6. 验收

- 两主题切换即时、无布局跳动、无残留硬边框（截图对比）。
- 侧栏 collapsed / float / docked 三态切换平滑且持久化；原生网页视图宽度随侧栏模式实时重算（不遮挡）。
- 终端面板全宽底部拉起后网页视口高度同步收缩（原生视图不被盖住）。
- 全量 typecheck / gen-check / build / vitest 绿；真机截图（两主题 × 侧栏三态 × 终端展开）。
