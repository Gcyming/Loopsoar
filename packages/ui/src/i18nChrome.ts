/**
 * ChromePage（历史 / 下载 / 收藏夹 / 设置整页）i18n 词典。
 *
 * 与 i18nBrowser/i18nSettings 分文件：由「浏览器管理整页」任务独占，避免并发改同一词典。
 * 结构：key → { zh, en }；i18n.ts 启动时合并进主词典（key 同名以本文件为准）。
 *
 * 约定：key 前缀 chromePage.<域>.<语义>；动态文案用 {param} 由 t(lang, key, params) 插值。
 */
export const CHROME_PAGE_I18N: Record<string, { zh: string; en: string }> = {
  /* ── 通用 ── */
  "chromePage.back": { zh: "返回", en: "Back" },
  "chromePage.loading": { zh: "加载中…", en: "Loading…" },
  "chromePage.error": { zh: "加载失败：{error}", en: "Failed to load: {error}" },
  "chromePage.retry": { zh: "重试", en: "Retry" },
  "chromePage.count": { zh: "共 {count} 条", en: "{count} items" },
  "chromePage.openSettings": { zh: "打开设置", en: "Open settings" },
  "chromePage.openHistory": { zh: "历史记录", en: "History" },
  "chromePage.openDownloads": { zh: "下载内容", en: "Downloads" },
  "chromePage.openBookmarks": { zh: "收藏夹", en: "Bookmarks" },
  "chromePage.unknownTime": { zh: "时间未知", en: "unknown time" },

  /* ── 页面标题 ── */
  "chromePage.title.history": { zh: "历史记录", en: "History" },
  "chromePage.title.downloads": { zh: "下载内容", en: "Downloads" },
  "chromePage.title.bookmarks": { zh: "收藏夹", en: "Bookmarks" },
  "chromePage.title.settings": { zh: "设置", en: "Settings" },

  /* ── 历史记录 ── */
  "chromePage.history.empty": {
    zh: "暂无历史记录。打开网页后这里会自动积累。",
    en: "No history yet. Pages you open will appear here.",
  },
  "chromePage.history.clear": { zh: "清除历史", en: "Clear history" },
  "chromePage.history.visits": { zh: "访问 {count} 次", en: "{count} visits" },
  "chromePage.history.visitedAt": { zh: "最近访问", en: "Last visited" },
  "chromePage.history.untitled": { zh: "（无标题）", en: "(untitled)" },
  "chromePage.history.selectAll": { zh: "全选", en: "Select all" },
  "chromePage.history.selected": { zh: "已选 {count} 项", en: "{count} selected" },
  "chromePage.history.cancel": { zh: "取消", en: "Cancel" },
  "chromePage.history.delete": { zh: "删除（{count}）", en: "Delete ({count})" },
  "chromePage.history.deleted": { zh: "已删除 {count} 条历史", en: "Deleted {count} history items" },

  /* ── 左侧索引栏（搜索 + 分类） ── */
  "chromePage.filter.all": { zh: "全部", en: "All" },
  "chromePage.filter.today": { zh: "今天", en: "Today" },
  "chromePage.filter.yesterday": { zh: "昨天", en: "Yesterday" },
  "chromePage.filter.earlier": { zh: "更早", en: "Earlier" },
  "chromePage.filter.recentWeek": { zh: "最近 7 天", en: "Last 7 days" },
  "chromePage.filter.noMatch": { zh: "没有匹配的内容", en: "No matching items" },
  "chromePage.search.history": { zh: "搜索历史记录", en: "Search history" },
  "chromePage.search.downloads": { zh: "搜索下载内容", en: "Search downloads" },
  "chromePage.search.bookmarks": { zh: "搜索收藏夹", en: "Search bookmarks" },

  /* ── 下载 ── */
  "chromePage.downloads.empty": { zh: "暂无下载内容。", en: "No downloads yet." },
  "chromePage.downloads.progressing": { zh: "进行中", en: "In progress" },
  "chromePage.downloads.completed": { zh: "已完成", en: "Completed" },
  "chromePage.downloads.cancelled": { zh: "已取消", en: "Cancelled" },
  "chromePage.downloads.interrupted": { zh: "失败", en: "Failed" },
  "chromePage.downloads.deleted": { zh: "已删除", en: "Deleted" },
  "chromePage.downloads.cancelledByUser": { zh: "用户取消", en: "Cancelled by user" },
  "chromePage.downloads.failedReason": { zh: "无法下载 - 网络错误", en: "Download failed - network error" },
  "chromePage.downloads.permission": { zh: "无法下载 - 没有权限", en: "Download failed - permission denied" },
  "chromePage.downloads.appClosed": { zh: "浏览器关闭，下载中断", en: "Browser closed, download interrupted" },
  "chromePage.downloads.stale": { zh: "上次退出时下载未完成", en: "Download unfinished from last session" },
  "chromePage.downloads.retry": { zh: "重试", en: "Retry" },
  "chromePage.downloads.percent": { zh: "{pct}%", en: "{pct}%" },
  "chromePage.downloads.savedTo": { zh: "保存到 {path}", en: "Saved to {path}" },
  "chromePage.downloads.cancel": { zh: "取消下载", en: "Cancel download" },
  "chromePage.downloads.showInFolder": { zh: "打开所在文件夹", en: "Show in folder" },
  "chromePage.downloads.remove": { zh: "移除记录", en: "Remove record" },
  "chromePage.downloads.removed": { zh: "已移除下载记录", en: "Download record removed" },
  "chromePage.downloads.openFile": { zh: "打开文件", en: "Open file" },
  "chromePage.downloads.copyLink": { zh: "复制下载链接", en: "Copy download link" },
  "chromePage.downloads.copied": { zh: "已复制下载链接", en: "Download link copied" },
  "chromePage.downloads.deleteFile": { zh: "删除文件", en: "Delete file" },
  "chromePage.downloads.deletedFile": { zh: "已删除文件", en: "File deleted" },
  "chromePage.downloads.fileDeleteFailed": { zh: "删除文件失败", en: "Failed to delete file" },

  /* ── 收藏夹 ── */
  "chromePage.bookmarks.empty": {
    zh: "暂无收藏。点击地址栏右侧的星标即可收藏当前页面。",
    en: "No bookmarks yet. Use the star button next to the address bar to bookmark a page.",
  },
  "chromePage.bookmarks.delete": { zh: "删除书签", en: "Delete bookmark" },
  "chromePage.bookmarks.removed": { zh: "已删除书签", en: "Bookmark deleted" },
  "chromePage.bookmarks.addedAt": { zh: "添加于 {time}", en: "Added {time}" },
  "chromePage.bookmarks.unavailable": { zh: "当前环境未提供书签服务", en: "Bookmark service is not available in this environment" },

  /* ── 设置页 ── */
  "chromePage.settings.hint": {
    zh: "设置已在整页中打开；按返回回到主界面。",
    en: "Settings are open full page; use Back to return.",
  },

  /* ── 管理页行右键菜单 ── */
  "chromePage.downloads.alwaysOpen": { zh: "始终打开这种类型的文件", en: "Always open files of this type" },
  "chromePage.downloads.alwaysOpenDone": { zh: "已设置：以后自动打开 {ext} 文件", en: "Set: always open {ext} files" },
  "chromePage.bookmarks.openInNewTab": { zh: "在新标签页中打开", en: "Open in new tab" },
  "chromePage.bookmarks.openInNewWindow": { zh: "在新窗口中打开", en: "Open in new window" },
  "chromePage.bookmarks.cut": { zh: "剪切", en: "Cut" },
  "chromePage.bookmarks.edit": { zh: "编辑", en: "Edit" },
  "chromePage.bookmarks.rename": { zh: "重命名", en: "Rename" },
  "chromePage.bookmarks.copyLink": { zh: "复制链接", en: "Copy link" },
  "chromePage.bookmarks.copied": { zh: "已复制链接", en: "Link copied" },
  "chromePage.bookmarks.updated": { zh: "已保存书签", en: "Bookmark saved" },
  "chromePage.bookmarks.editTitle": { zh: "编辑书签", en: "Edit bookmark" },
  "chromePage.bookmarks.titleLabel": { zh: "名称", en: "Name" },
  "chromePage.bookmarks.urlLabel": { zh: "网址", en: "URL" },
  "chromePage.bookmarks.save": { zh: "保存", en: "Save" },
  "chromePage.bookmarks.cancel": { zh: "取消", en: "Cancel" },
  "chromePage.bookmarks.cutDone": { zh: "已剪切书签（链接已复制）", en: "Bookmark cut (link copied)" },
  "chromePage.bookmarks.cutNoCopy": { zh: "已剪切书签（复制链接失败）", en: "Bookmark cut (copy failed)" },
  "chromePage.history.openInNewTab": { zh: "在新标签页中打开", en: "Open in new tab" },
  "chromePage.history.openInNewWindow": { zh: "在新窗口中打开", en: "Open in new window" },
  "chromePage.history.copyLink": { zh: "复制链接", en: "Copy link" },
  "chromePage.history.copied": { zh: "已复制链接", en: "Link copied" },
  "chromePage.history.deleteItem": { zh: "删除", en: "Delete" },
  "chromePage.history.moreFromSite": { zh: "来自相同站点的更多内容", en: "More from this site" },
};
