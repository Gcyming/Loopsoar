/**
 * 文件写入工具（产物卡的唯一数据源）：
 *   · 只允许写工作区根内路径（防穿越）；父目录自动创建；
 *   · 结果内嵌 `[__loops_diff__]base64{path,oldText,newText}[/__loops_diff__]` 标记，
 *     UI 解析成 VS Code 风格 diff 与产物卡；标记之外的文本是给模型/用户看的摘要；
 *   · 权限声明 { write: true } → 默认每次确认（设置·权限可改）。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

const MAX_OLD_BYTES = 200_000;
const DIFF_OPEN = "[__loops_diff__]";
const DIFF_CLOSE = "[/__loops_diff__]";

function encodeMarker(payload: { path: string; oldText: string; newText: string }): string {
  return `${DIFF_OPEN}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}${DIFF_CLOSE}`;
}

function diffStat(oldText: string, newText: string): { add: number; del: number } {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const count = oldSet.get(line) ?? 0;
    if (count > 0) oldSet.set(line, count - 1);
    else added += 1;
  }
  const removed = [...oldSet.values()].reduce((sum, count) => sum + count, 0);
  return { add: added, del: removed };
}

function resolveInside(root: string, relative: string): { ok: true; target: string; rel: string } | { ok: false; reason: string } {
  const target = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return { ok: false, reason: "路径越界：只能写工作区内的文件" };
  }
  return { ok: true, target, rel: path.relative(rootResolved, target) || path.basename(target) };
}

export function registerFileTools(registry: ToolRegistry, workspaceRoot: (sessionId?: string) => string): void {
  registry.register({
    name: "file_write",
    description: "在工作区内新建/覆盖文件（自动建父目录）；返回改动摘要与可视化 diff 数据",
    permissions: { write: true },
    schema: z.object({ path: z.string().min(1).max(1000), content: z.string().max(2_000_000) }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { path?: string; content?: string };
      if (!params.path) return { ok: false, content: "[错误] 缺少 path" };
      const root = workspaceRoot(ctx.sessionId) || process.cwd();
      const resolved = resolveInside(root, params.path);
      if (!resolved.ok) return { ok: false, content: `[错误] ${resolved.reason}` };
      const next = params.content ?? "";
      try {
        let old = "";
        if (fs.existsSync(resolved.target)) {
          const stat = fs.statSync(resolved.target);
          if (stat.isDirectory()) return { ok: false, content: `[错误] 目标是目录：${resolved.rel}` };
          const raw = fs.readFileSync(resolved.target, "utf8");
          old = raw.length > MAX_OLD_BYTES ? raw.slice(0, MAX_OLD_BYTES) : raw;
        }
        fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
        fs.writeFileSync(resolved.target, next, "utf8");
        const stat = diffStat(old, next);
        const marker = encodeMarker({ path: resolved.rel, oldText: old, newText: next });
        return {
          ok: true,
          content: `已写入 ${resolved.rel}（+${stat.add} −${stat.del} 行，${next.length} 字符）\n${marker}`,
        };
      } catch (err) {
        return { ok: false, content: `[错误] 写入失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
