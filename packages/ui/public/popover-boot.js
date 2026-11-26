// 浮层窗口首帧：在模块 bundle 加载前就把「这是浮层窗口」标出来。
// 关键：html[data-popover] 的整页透明规则必须首帧生效，否则 body 的 --ls-bg 会先画成
// 一块不透明深色矩形，窗口出现时就会「闪一下」。
try {
  if (location.search.indexOf("popover=") !== -1) {
    document.documentElement.setAttribute("data-popover-loading", "1");
    document.documentElement.setAttribute("data-popover", "1");
  }
} catch (err) {
  // 极端环境（location 不可用）忽略
}
