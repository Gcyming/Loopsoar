/**
 * 附件文本协议（纯逻辑）：用户消息里的 `【附件】<path>` 拆成正文 + 附件路径。
 * 为什么单独成模块：展示层与发送层必须用同一份解析，避免"显示有附件、发送丢路径"。
 */
export function splitAttachments(text: string): { body: string; docs: string[] } {
  const docs: string[] = [];
  const found = new Set<string>();
  const push = (value: string): void => {
    const path = value.trim();
    if (!path || found.has(path)) return;
    found.add(path);
    docs.push(path);
  };
  // 新格式带闭合符：路径可与正文同行；旧格式（无闭合符）继续兼容。
  const closed = /【附件】([^\n]*?)【\/附件】/g;
  let match: RegExpExecArray | null;
  while ((match = closed.exec(text)) !== null) push(match[1]);
  const legacy = /【附件】([^\n]+)/g;
  while ((match = legacy.exec(text)) !== null) {
    let path = match[1].trim();
    const end = path.indexOf("【/附件】");
    if (end >= 0) path = path.slice(0, end);
    push(path);
  }
  const body = text.replace(closed, "").replace(legacy, "").trim();
  return { body, docs };
}

export function baseName(path: string): string {
  // 同时兼容 Windows 反斜杠与 POSIX 正斜杠（此前正则只匹配了 `/`，Windows 路径整串返回）
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
