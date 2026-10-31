/**
 * 产物/引用/差异的纯逻辑（无 React、无 IO）：
 *   · 从工具结果里解析内嵌 diff 标记（file_write 产物）；
 *   · 简单行级 diff（LCS 的动态规划实现只用于小文件，超阈值退化为整块替换）；
 *   · 从时间线收集「参考内容」（读过的文件 / 访问过的网址）与「产物」（写入的文件）。
 *
 * 为什么独立成模块：时间线渲染（TimelineView）与会话级产物面板都要用同一份解析，
 * 放两处必然漂移；这里的函数全部可单测。
 */
import type { TimelineStep } from "./timeline.js";

export interface FileDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface DiffLine {
  op: "=" | "+" | "-";
  text: string;
}

export interface ProductFile {
  path: string;
  label: string;
  add: number;
  del: number;
  oldText: string;
  newText: string;
}

const DIFF_OPEN = "[__loops_diff__]";
const DIFF_CLOSE = "[/__loops_diff__]";

/** 把文件改动编码进工具结果（服务端用；UI 解析后隐藏）。 */
export function encodeDiffMarker(diff: FileDiff): string {
  return `${DIFF_OPEN}${base64Encode(JSON.stringify(diff))}${DIFF_CLOSE}`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯 JS base64（浏览器/Node/测试环境一致，不依赖 Buffer/atob 的可用性）。 */
function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

function base64Decode(payload: string): string {
  const clean = payload.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? -1 : B64.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? -1 : B64.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) continue;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 从任意文本里剥离 diff 标记（模型可能把工具结果原样复述进正文）。 */
export function stripDiffMarkers(text: string): string {
  return text.replace(/\[__loops_diff__\][\s\S]*?\[\/__loops_diff__\]/g, "").trim();
}

/** 从工具结果分离「人类可读文本」与「diff 数据」。 */
export function parseDiffResult(result: string | undefined): { clean: string; diff: FileDiff | null } {
  const raw = result ?? "";
  const start = raw.indexOf(DIFF_OPEN);
  const end = raw.indexOf(DIFF_CLOSE, start + DIFF_OPEN.length);
  if (start < 0 || end < 0) return { clean: raw, diff: null };
  const payload = raw.slice(start + DIFF_OPEN.length, end);
  const clean = `${raw.slice(0, start)}${raw.slice(end + DIFF_CLOSE.length)}`.trim();
  try {
    const parsed = JSON.parse(base64Decode(payload)) as Partial<FileDiff>;
    if (typeof parsed.path !== "string" || typeof parsed.oldText !== "string" || typeof parsed.newText !== "string") {
      return { clean, diff: null };
    }
    return {
      clean,
      diff: { path: parsed.path.replace(/\\/g, "/"), oldText: parsed.oldText, newText: parsed.newText },
    };
  } catch {
    return { clean, diff: null };
  }
}

/** 行级 diff：小文本用 LCS；超大文本退化为「全删 + 全增」避免界面卡死。 */
export function diffLines(oldText: string, newText: string, maxLines = 400): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length + newLines.length > maxLines) {
    return [
      ...oldLines.map((text) => ({ op: "-" as const, text })),
      ...newLines.map((text) => ({ op: "+" as const, text })),
    ];
  }
  const width = newLines.length + 1;
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(width).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ op: "=", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ op: "-", text: oldLines[i] });
      i += 1;
    } else {
      lines.push({ op: "+", text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    lines.push({ op: "-", text: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    lines.push({ op: "+", text: newLines[j] });
    j += 1;
  }
  return lines;
}

export function diffStat(lines: DiffLine[]): { add: number; del: number } {
  return {
    add: lines.filter((line) => line.op === "+").length,
    del: lines.filter((line) => line.op === "-").length,
  };
}

/** 产物：file_write 类工具结果里的 diff 标记 → 文件卡片数据。 */
export function collectProducts(timeline: TimelineStep[]): ProductFile[] {
  const products: ProductFile[] = [];
  const seen = new Set<string>();
  for (const step of timeline) {
    if (step.kind !== "tool" || !step.result) continue;
    const { diff } = parseDiffResult(step.result);
    if (!diff || seen.has(diff.path)) continue;
    seen.add(diff.path);
    const lines = diffLines(diff.oldText, diff.newText);
    const stat = diffStat(lines);
    products.push({
      path: diff.path,
      label: diff.path.split(/[\\/]/).pop() ?? diff.path,
      ...stat,
      oldText: diff.oldText,
      newText: diff.newText,
    });
  }
  return products;
}

export interface ReferenceGroups {
  files: { path: string; label: string }[];
  urls: { url: string; label: string }[];
}

/** 参考内容：file_read 的路径、browser_navigate/web_fetch 的网址（去重保序）。 */
export function collectReferences(timeline: TimelineStep[]): ReferenceGroups {
  const files: { path: string; label: string }[] = [];
  const urls: { url: string; label: string }[] = [];
  const seenFiles = new Set<string>();
  const seenUrls = new Set<string>();
  for (const step of timeline) {
    if (step.kind !== "tool") continue;
    const name = step.name;
    const detail = step.detail ?? "";
    if (/^(file_read|file_write|file_list)$/i.test(name) && detail) {
      if (!seenFiles.has(detail)) {
        seenFiles.add(detail);
        files.push({ path: detail, label: detail.split(/[\\/]/).pop() ?? detail });
      }
    }
    if (/browser_navigate|web_fetch|browser_snapshot/i.test(name)) {
      const url = /^https?:\/\//i.test(detail) ? detail : (/https?:\/\/[^\s"'<>)\]]+/.exec(step.result ?? "")?.[0] ?? "");
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        try {
          urls.push({ url, label: new URL(url).hostname });
        } catch {
          urls.push({ url, label: url });
        }
      }
    }
  }
  return { files, urls };
}
