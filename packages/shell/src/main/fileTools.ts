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
import { sensitivePathReason } from "loopsoar-core/tools/classifier";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { CheckpointStore } from "./checkpointStore.js";

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

export function registerFileTools(
  registry: ToolRegistry,
  workspaceRoot: (sessionId?: string) => string,
  checkpoints?: CheckpointStore,
): void {
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
      const guard = sensitivePathReason(resolved.rel);
      if (guard) {
        const kind = guard === "sensitive" ? "敏感文件" : "受保护源代码目录";
        return {
          ok: false,
          content: `[错误] ${kind}不允许 Agent 直接写入：${resolved.rel}（需人工在编辑器中操作）`,
        };
      }
      const next = params.content ?? "";
      try {
        let old = "";
        if (fs.existsSync(resolved.target)) {
          const stat = fs.statSync(resolved.target);
          if (stat.isDirectory()) return { ok: false, content: `[错误] 目标是目录：${resolved.rel}` };
          const raw = fs.readFileSync(resolved.target, "utf8");
          old = raw.length > MAX_OLD_BYTES ? raw.slice(0, MAX_OLD_BYTES) : raw;
        }
        // 回合级快照：只记第一次写入前的旧内容，回滚 = 回到本回合开始前。
        // 内容没变的覆盖不备份（capture 内部判定）。
        checkpoints?.capture(ctx.sessionId ?? "default", resolved.target, resolved.rel, next);
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

  if (!checkpoints) return;

  registry.register({
    name: "checkpoint_list",
    description:
      "列出本会话最近的回合检查点（Agent 经 file_write 改过的文件快照）。回滚前先用它确认要退回哪一回合；只读，不改变文件。",
    permissions: { read: true },
    schema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { limit?: number };
      const list = checkpoints.list(ctx.sessionId ?? "default", params.limit ?? 10);
      if (list.length === 0) return { ok: true, content: "本会话还没有可回滚的检查点。" };
      const lines = list.map((item) => {
        const when = new Date(item.createdAt).toISOString().replace("T", " ").slice(0, 19);
        const files = item.files
          .slice(0, 6)
          .map((file) => `${file.rel}${file.existed ? "" : "（新建）"}`)
          .join("、");
        return `- ${item.id}｜${when}｜${item.label}｜${files}${item.files.length > 6 ? ` 等 ${item.files.length} 个` : ""}`;
      });
      return { ok: true, content: `检查点（${list.length} 个，最新在前）：\n${lines.join("\n")}` };
    },
  });

  registry.register({
    name: "checkpoint_restore",
    description:
      "把本会话的文件回滚到某个检查点之前（缺省最近一个）：恢复被覆盖文件、删除该回合新建的文件。需要用户确认；只覆盖 file_write 的改动，不覆盖 terminal_run 的副作用。",
    permissions: { write: true },
    schema: z.object({ id: z.string().trim().min(1).max(80).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { id?: string };
      const root = workspaceRoot(ctx.sessionId) || process.cwd();
      const result = checkpoints.restore(ctx.sessionId ?? "default", root, params.id);
      if (result.restored === 0 && result.deleted === 0) {
        return { ok: false, content: `[错误] 回滚未生效：${result.errors.join("；") || "检查点为空"}` };
      }
      const parts = [`已回滚到 ${result.checkpointId}`];
      if (result.restored) parts.push(`恢复 ${result.restored} 个文件`);
      if (result.deleted) parts.push(`删除 ${result.deleted} 个本回合新建文件`);
      if (result.errors.length) parts.push(`未完成：${result.errors.join("；")}`);
      return { ok: true, content: parts.join("；") };
    },
  });
}
