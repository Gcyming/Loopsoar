/**
 * 附件文本协议（纯逻辑）：用户消息里的 `【附件】<path>` 拆成正文 + 附件路径。
 * 为什么单独成模块：展示层与发送层必须用同一份解析，避免"显示有附件、发送丢路径"。
 */
export function splitAttachments(text: string): { body: string; docs: string[] } {
  const docs: string[] = [];
  const re = /【附件】([^\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = match[1].trim();
    if (path) docs.push(path);
  }
  const body = text.replace(re, "").trim();
  return { body, docs };
}

export function baseName(path: string): string {
  const parts = path.split(/[\/]/);
  return parts[parts.length - 1] || path;
}
