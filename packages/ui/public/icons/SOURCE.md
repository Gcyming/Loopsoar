# 图标资产来源与映射（本地图标库）

本目录的 SVG 全部来自用户收录的本地图标库 `Loopsoar/icon/icon_fpbc119q3rk/`
（另一个 `icon/icon_1cdszr8as42/` 是字母类图标，本 UI 未使用）。

## 使用方式

`Icon.tsx` 把 SVG 当作 CSS `mask`（`--icon: url(./icons/<name>.svg)`），
以 `background-color: currentColor` 染色。因此：

- **源文件的 `fill` 颜色会被忽略**，图标颜色永远跟随所在文字色/主题；
- 新增/替换图标只需保证文件名（ASCII、小写、`-` 分隔）被 `<Icon name="...">` 引用；
- `tests/ui/icons.spec.ts` 会扫描 `packages/ui/src/**` 里的 `<Icon name="...">`，
  断言每个 name 都有同名 `.svg`，防止引用缺失。

## 映射表

| 目标文件 | 源文件（`icon/icon_fpbc119q3rk/`） | 用途 |
| --- | --- | --- |
| `agent.svg` | `智能体.svg` | Agent 头像/标识 |
| `arrow-go.svg` | `arrow-narrow-right.svg` | 「跳转/继续/委派」横向箭头（思考时间线「委派子代理」） |
| `back.svg` | `chevron-left.svg` | 返回/上一级 |
| `bolt.svg` | `bolt.svg` | 快捷/自动模式 |
| `bulb.svg` | `bulb.svg` | 提示/灵感/陪伴语 |
| `capture.svg` | `capture.svg` | 截图/捕获网页 |
| `check.svg` | `check.svg` | 成功/完成/已选 |
| `close.svg` | `close.svg` | 关闭/失败/删除 |
| `cloud-upload.svg` | `cloud-upload.svg` | 上传/发布 |
| `download.svg` | `download.svg` | 下载 |
| `file.svg` | `file-text.svg` | 文件/参考文件/产物 |
| `folder.svg` | `folder.svg` | 文件夹/工作区 |
| `folders.svg` | `folders.svg` | 多文件夹/工作区列表 |
| `forward.svg` | `chevron-right.svg` | 前进/下一步 |
| `history.svg` | `history.svg` | 历史会话/历史记录 |
| `home.svg` | `home.svg` | 首页/欢迎页 |
| `minimize.svg` | `minus.svg` | 窗口最小化 |
| `more.svg` | `more.svg` | 更多菜单（横向三点） |
| `notes.svg` | `notes.svg` | 备忘录/会话摘要 |
| `paperclip.svg` | `paperclip.svg` | 附件（输入框回形针） |
| `plus.svg` | `plus.svg` | 新建/新增 |
| `puzzle.svg` | `puzzle.svg` | 扩展/技能 |
| `refresh.svg` | `refresh.svg` | 刷新（环形箭头，带箭头头部） |
| `reload.svg` | `reload.svg` | 重新加载/重试（环形箭头） |
| `search.svg` | `search.svg` | 搜索 |
| `send.svg` | `guide-arrow.svg` | **发送**（向上箭头，用户指定替换原横向箭头） |
| `settings.svg` | `adjust.svg` | 设置（滑杆式） |
| `spinner.svg` | `a-loadingcircle.svg` | 加载中（配合 `.spinner` CSS 旋转） |
| `star.svg` | `star.svg` | 收藏（未选中） |
| `star-filled.svg` | `star-filled.svg` | 收藏（已选中） |
| `stop.svg` | `终止.svg` | 中断/停止生成 |
| `terminal.svg` | `terminal.svg` | 终端/执行命令 |
| `warning.svg` | `Warning.svg` | 警告/错误提示 |
| `link.svg` | `link.svg` | 链接（思考时间线 URL） |
| `globe.svg` | `互联网.svg` | 网页/访问来源 |
| `edit.svg` | `edit.svg` | 写入/编辑工具 |
| `play.svg` | `caret-right-filled.svg` | 进行中/开始（实心三角） |
| `maximize.svg` | **自绘**（见下） | 窗口最大化（单方框） |
| `restore.svg` | **自绘**（见下） | 窗口还原（两叠方框） |
| `circle.svg` | **自绘** | 待办未开始（空心圆） |
| `sparkle.svg` | **自绘** | 「思考过程」标题装饰（四角星） |
| `checkbox.svg` | **自绘** | 任务规划（带勾选框） |
| `copy.svg` | `复制.svg` | 复制动作（消息/会话/代码块统一图标，用户 m02010） |
| `layers-linked.svg` | `layers-linked.svg` | 记忆类工具（时间线「记忆」类型） |
| `list-details.svg` | `list-details.svg` | 任务规划（时间线 plan 节点） |

## 自绘图标说明

图标库缺少「窗口方框」「空心圆/勾选框」「四角星」这类基础形状，以下 5 个按库内
风格自绘（1024 viewBox、线宽 76.8 ≈ 38.4×2、圆角 102.4，与库内描边粗细一致；
`fill/stroke` 写成 `#515151` 只是占位，mask 染色时会被忽略）：

- `maximize.svg`：单个圆角方框（`rect` 132/132/760/760、rx 102.4）；
- `restore.svg`：外层方框只画左上 L 形（避免与内层方框线条打架），内层为完整方框；
- `circle.svg`：空心圆（r=326，描边 76.8）；
- `sparkle.svg`：四角星（两次三次贝塞尔收尖）；
- `checkbox.svg`：圆角方框 + 对勾。

## 维护规则

1. 新图标一律复制（不要重命名源文件后直接引用中文名）到本目录，使用 ASCII 小写名；
2. 同步更新本文件映射表；更新源图标时以「目标文件 ← 源文件」重新复制；
3. 不要全量拷贝图标库（约 168 个），只保留 UI 实际用到的一套（当前 47 个）；
4. 删除图标前先确认 `packages/ui/src/**` 无 `<Icon name="...">` 引用（`tests/ui/icons.spec.ts` 会兜底）。

| `devtools.svg` | `D:/下载/操作-调试.svg` | 状态栏调试按钮 / DevTools 面板图标 | 2026-11-13 |
| `extension-feature.svg` | `D:/下载/扩展功能.svg` | 设置 · Agent 扩展 | 2026-11-13 |
| `browser-plugin.svg` | `D:/下载/组件、插件.svg` | 设置 · 浏览器扩展 | 2026-11-13 |
| `volume-2.svg` | 用户提供 | 标签页有声 / 菜单「取消静音」 | 2026-11-21 |
| `volume-x.svg` | 用户提供 | 标签页已静音 / 菜单「静音」 | 2026-11-21 |
