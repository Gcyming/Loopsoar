# ADR-0151 浏览器输入命中、iframe 编辑区与左侧呼吸位

日期：2026-11-28
状态：已采纳

## 背景

用户反馈（m01462，截图 m01463）：浏览器操作时点击输入框不生效、无法输入；工具报 `[BLOCKED_BY_OVERLAY] textarea 的中心点被 div.subNav「暂时保存 提交 作业」遮挡`。同一页面还存在 UEditor 富文本编辑区。另要求网页左侧不要贴死程序边界，并把 Agent 控制时的光晕向页面中心多渲染。

## 根因

1. `locateJs` 对 CSS 选择器直接 `document.querySelector`，取 DOM 里第一个匹配。UEditor 会保留一个用于表单同步的隐藏 textarea，它排在真正的编辑区之前；点击坐标落在 0,0 或吸顶栏后面。
2. 点击命中验证只测元素中心一个点。吸顶工具栏盖住中心时直接判 BLOCKED_BY_OVERLAY，但元素下半部分其实可点。
3. 富文本编辑体的 `contenteditable` 在 iframe 内：主文档 `elementFromPoint` 只返回 iframe，`document.activeElement` 也只是 iframe；原焦点校验/回读因此失败。
4. `browser_type` 在真实点击失败后无条件回退原生 setter，可能写进隐藏 textarea，工具返回成功但页面正文没变。

## 决策

- 选择器解析可见优先：CSS 命中多个时取第一个真正可见的（尺寸 >2px、非 display:none/visibility:hidden/opacity:0）；全部不可见返回 ELEMENT_NOT_VISIBLE，提示改用 browser_snapshot 的 #eN 或 contenteditable/iframe。
- 命中验证多落点：中心失败后依次试 22%/78% 上下、左右及接近边缘的位置，选第一个真正命中目标（或目标后代）的点；全部被挡才报 BLOCKED_BY_OVERLAY，并在文案里给出已尝试落点数与滚动建议。
- 快照过滤完全被遮挡的元素，避免模型反复点「看得见名字却点不到」的隐藏 textarea；同时把同源 iframe 纳入快照，contenteditable 的 iframe 标为 textbox（名称「内嵌编辑区」）。
- iframe 编辑区支持：target-point 识别 iframe 内 body/contenteditable，editable=true；焦点校验同时检查主文档 activeElement 与 frame 内 activeElement/body；输入回读读 frame body.innerText；原生 setter 兜底直接写 frame body 文本。
- 点击后等 90ms（iframe 180ms）再校验焦点，避免真实鼠标事件尚未进入渲染进程就误报 FOCUS_MISMATCH。
- 目标被遮挡时不再回退 setter，直接返回可行动错误。
- 布局：新增 BROWSER_VIEW_INSET_LEFT=8，只收左侧；顶部/右侧/底部仍贴边，原生 WebContentsView 与 DOM StartPage/Freeze 共用同一常量。
- 光晕：在 Agent 指针覆盖层的 #glow 上增加向内的径向渐变与 92px inset 阴影，并保留贴边描边；去掉会伸出页面矩形、被覆盖窗口方边界裁成四角方块的外阴影，圆角直接复用 LAYOUT.BROWSER_VIEW_RADIUS。

## 后果

- 吸顶栏下的输入框、UEditor 等 iframe 编辑区可通过真实鼠标/键盘操作；隐藏源 textarea 不再出现在快照里。
- 富文本编辑器若使用跨域 iframe，仍只能按 frame 整体点击，不能读取内层内容（浏览器同源策略限制）。
- 左侧 8px 留白会让原生视图宽度减 8，相关布局测试同步更新；页面仍是视觉主体。
