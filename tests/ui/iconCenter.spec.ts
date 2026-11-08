/**
 * 图标居中守卫（用户 m02115：「标签页关闭 × 在圆形 hover 底里偏了」）。
 *
 * 历史教训：图标库里的 SVG 图形本身并不总是画在 1024 viewBox 正中间，
 * 放进 .icon-btn / .win-btn / .tab-close 这类「居中裁切」的小圆底按钮后就会偏。
 * 这里用与 scripts/icon-center-check.mjs 相同的几何 bbox 实现（scripts/icon-center-lib.mjs，
 * 曲线采样，误差 <1%），对全量图标断言可见图形中心与 viewBox 中心的偏移在容差内。
 *
 * 同时也校验历史修复清单：这些 SVG 内部必须保留 <g transform="translate(...)"> 补偿，
 * 防止有人重采样/替换图标资产时把居中修正悄悄丢掉。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { centerOffset, computeSvgBBox } from "../../scripts/icon-center-lib.mjs";

const ROOT = process.cwd();
const ICON_DIR = path.join(ROOT, "packages", "ui", "public", "icons");
/** 容差（百分比）：脚本按 2% 报告，守卫略放宽到 2.5% 吸收取样误差。 */
const TOLERANCE_PERCENT = 2.5;

/** 用户 m02115 修复过的图标（补了 translate 使其居中），不要重采样时丢失。 */
const CENTERED_ICONS = [
  "agent",
  "back",
  "bolt",
  "check",
  "download",
  "edit",
  "folders",
  "forward",
  "guide-arrow",
  "play",
  "settings",
];

const svgFiles = fs.readdirSync(ICON_DIR).filter((file) => file.endsWith(".svg"));

describe("图标可见图形居中（alpha/几何 bbox 中心 ≈ viewBox 中心）", () => {
  it("public/icons 全量图标偏移均在容差内", () => {
    const offenders = [];
    for (const file of svgFiles) {
      const text = fs.readFileSync(path.join(ICON_DIR, file), "utf8");
      const bbox = computeSvgBBox(text);
      if (!bbox) {
        offenders.push(`${file}: 未解析到可见图形`);
        continue;
      }
      const offset = centerOffset(bbox);
      if (Math.abs(offset.dx) > TOLERANCE_PERCENT || Math.abs(offset.dy) > TOLERANCE_PERCENT) {
        offenders.push(`${file}: dx=${offset.dx.toFixed(2)}% dy=${offset.dy.toFixed(2)}%`);
      }
    }
    expect(offenders, `以下图标偏离中心（>${TOLERANCE_PERCENT}%）：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("历史修复清单的 SVG 保留 translate 补偿（防止资产被重采样后回退）", () => {
    const missing = CENTERED_ICONS.filter((name) => {
      const file = path.join(ICON_DIR, `${name}.svg`);
      if (!fs.existsSync(file)) return true;
      return !/<g\s+transform="translate\(/.test(fs.readFileSync(file, "utf8"));
    });
    expect(missing, `这些图标缺少居中 translate 补偿：${missing.join(", ")}`).toEqual([]);
  });

  it("图标资产仍是 1024×1024 viewBox（脚本与容差都依赖这个假设）", () => {
    const bad = svgFiles.filter((file) => !/viewBox="0 0 1024 1024"/.test(fs.readFileSync(path.join(ICON_DIR, file), "utf8")));
    expect(bad, `非 1024 viewBox：${bad.join(", ")}`).toEqual([]);
  });
});
