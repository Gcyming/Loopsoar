/**
 * 图标居中检查（Node，纯几何 bbox；与 tests/ui/iconCenter.spec.ts 共用 scripts/icon-center-lib.mjs）。
 *
 * 背景（用户 m02115）：SVG 图形没有画在 1024 viewBox 的正中间时，放进 .icon-btn /
 * .win-btn / .tab-close 的圆底按钮会视觉偏移。本脚本扫描目录下所有 SVG，计算可见图形
 * bbox 中心相对 viewBox 中心的偏移（百分比）。
 *
 * 用法（仓库根执行）：
 *   node scripts/icon-center-check.mjs                       # 只检查
 *   node scripts/icon-center-check.mjs --fix                 # 对超阈值图标包 <g transform>
 *   node scripts/icon-center-check.mjs --threshold=2 --json=...  # 自定义阈值/输出 JSON
 *   node scripts/icon-center-check.mjs --dir=<其它目录>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { centerOffset, computeSvgBBox } from "./icon-center-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dir = path.resolve(ROOT, argValue("dir", path.join("packages/ui/public/icons")));
const threshold = Number(argValue("threshold", "2"));
const fix = process.argv.includes("--fix");
const jsonOut = argValue("json", "");

/** 用 <g transform="translate(dx dy)"> 包住整个 SVG 内容（累积补偿：已有 transform 也安全）。 */
function wrapTranslate(text, dx, dy) {
  const open = text.indexOf(">", text.indexOf("<svg"));
  const close = text.lastIndexOf("</svg>");
  if (open < 0 || close < 0) throw new Error("SVG 结构异常：缺少 <svg>/</svg>");
  const fmt = (v) => (Math.round(v * 100) / 100).toString();
  return `${text.slice(0, open + 1)}<g transform="translate(${fmt(dx)} ${fmt(dy)})">${text.slice(open + 1, close)}</g>${text.slice(close)}`;
}

const files = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".svg"))
  .sort();

const results = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const bbox = computeSvgBBox(text);
  if (!bbox) {
    results.push({ name: file.replace(/\.svg$/, ""), error: "no-geometry" });
    continue;
  }
  const offset = centerOffset(bbox);
  results.push({
    name: file.replace(/\.svg$/, ""),
    dx: Number(offset.dx.toFixed(2)),
    dy: Number(offset.dy.toFixed(2)),
  });
}

const bad = results.filter((item) => !item.error && (Math.abs(item.dx) > threshold || Math.abs(item.dy) > threshold));
results.sort((a, b) => Math.hypot(b.dx ?? 0, b.dy ?? 0) - Math.hypot(a.dx ?? 0, a.dy ?? 0));

console.log(`扫描目录: ${dir} (${results.length} 个 SVG，阈值 ${threshold}%)`);
for (const item of results) {
  const mark = item.error ? "ERR" : Math.abs(item.dx) > threshold || Math.abs(item.dy) > threshold ? "X  " : "OK ";
  console.log(`${mark} ${item.name.padEnd(22)} dx=${String(item.dx ?? "-").padStart(7)}%  dy=${String(item.dy ?? "-").padStart(7)}%${item.error ? ` (${item.error})` : ""}`);
}
console.log(`偏移超阈值: ${bad.length} 个${bad.length > 0 ? ` -> ${bad.map((item) => item.name).join(", ")}` : ""}`);

if (fix) {
  let fixed = 0;
  for (const item of bad) {
    const file = path.join(dir, `${item.name}.svg`);
    const text = fs.readFileSync(file, "utf8");
    const bbox = computeSvgBBox(text);
    if (!bbox) continue;
    const dx = -(item.dx / 100) * bbox.viewBox.width;
    const dy = -(item.dy / 100) * bbox.viewBox.height;
    fs.writeFileSync(file, wrapTranslate(text, dx, dy));
    fixed += 1;
    console.log(`FIXED ${item.name}.svg  translate(${dx.toFixed(2)} ${dy.toFixed(2)})  <- dx=${item.dx}% dy=${item.dy}%`);
  }
  console.log(`共修正 ${fixed} 个图标；请重跑确认偏移 < ${threshold}%`);
}

if (jsonOut) {
  const outPath = path.resolve(ROOT, jsonOut);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({ threshold, generatedAt: new Date().toISOString(), results: results.filter((item) => !item.error) }, null, 2)}\n`,
  );
  console.log(`JSON: ${outPath}`);
}
