/**
 * 会话列表搜索评分（纯函数，单一产地；SessionListPanel 与单测共用）。
 *
 * 相关性顺序：标题精确匹配 > 标题前缀 > 标题包含 > 预览包含 > 多词元全部命中。
 * 同分按更新时间倒序（由调用方负责），保证「输入足够准确时精准会话排第一」。
 */
import type { SessionMeta } from "./types.js";

export function sessionMatchScore(session: Pick<SessionMeta, "title" | "preview">, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = session.title.toLowerCase();
  if (title === q) return 1000;
  if (title.startsWith(q)) return 800;
  if (title.includes(q)) return 600;
  if (session.preview.toLowerCase().includes(q)) return 300;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (
    tokens.length > 1 &&
    tokens.every((token) => title.includes(token) || session.preview.toLowerCase().includes(token))
  ) {
    return 200;
  }
  return 0;
}
