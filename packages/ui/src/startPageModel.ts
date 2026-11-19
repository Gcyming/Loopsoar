/** StartPage 的纯函数小工具。 */
/** 从 URL 取可读主机名（错误页/加载页展示用）。 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.pathname || url;
  } catch {
    return url;
  }
}

export function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(152, Math.max(22, el.scrollHeight))}px`;
}
