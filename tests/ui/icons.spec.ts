/**
 * 图标资产一致性守卫。
 *
 * 为什么用源码扫描而不是运行时渲染：
 *   - 图标缺失/命名漂移是构建期问题，正则扫描能在失败信息里直接给出文件+行号；
 *   - 不需要 jsdom，跑得比渲染测试快，也不会被 CSS mask 在测试环境里的行为干扰。
 *
 * 覆盖四类回归：
 *   1. `<Icon name="...">` 引用的每个名字都必须有 `public/icons/<name>.svg`；
 *   2. 窗口/输入区等关键能力使用的规范名必须齐全（防止重构时误删）；
 *   3. 资产文件名必须 ASCII kebab-case（避免中文名在打包/跨平台路径上出问题）；
 *   4. 源码里禁止再用 pictographic emoji 充当图标（用户明确要求）。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const UI_SRC = path.join(ROOT, "packages", "ui", "src");
const ICON_DIR = path.join(ROOT, "packages", "ui", "public", "icons");

/** 跨平台递归收集源码文件（不依赖 glob 依赖，测试环境保持零额外包）。 */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

const svgFiles = fs.readdirSync(ICON_DIR).filter((file) => file.endsWith(".svg"));
const svgNames = new Set(svgFiles.map((file) => file.slice(0, -4)));
const sourceFiles = walkFiles(UI_SRC).filter((file) => /\.(ts|tsx)$/.test(file));

/**
 * 关键规范名：窗口控制、输入区、状态与常用入口。
 * 这些名字被其它 teammate 的组件跨文件引用，单独断言可以防止「删了资产却没人发现」。
 */
const REQUIRED_ICONS = [
  // 窗口与导航
  "minimize",
  "maximize",
  "restore",
  "close",
  "back",
  "forward",
  "history",
  "home",
  // 输入与动作
  "send",
  "stop",
  "paperclip",
  "plus",
  "more",
  "search",
  "reload",
  "refresh",
  "download",
  "capture",
  // 状态与主题
  "check",
  "warning",
  "spinner",
  "star",
  "star-filled",
  "bolt",
  "bulb",
  "puzzle",
  // 文件与工作区
  "file",
  "folder",
  "folders",
  "notes",
  "terminal",
  "agent",
  "settings",
  "cloud-upload",
  "arrow-go",
  // 思考时间线/工具分类（glyphFor 动态引用，静态正则扫不到，这里显式兜底）
  "link",
  "globe",
  "edit",
  "play",
  "sparkle",
  "circle",
  "checkbox",
  // 时间线图标化（toolVisual 动态返回图标名）+ 复制动作统一图标
  "copy",
  "layers-linked",
  "list-details",
  "guide-arrow",
];

/** pictographic emoji（用户明确不要表情符号当图标；箭头 → ← ↳ 属于排版符号，保留）。 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

interface IconRef {
  name: string;
  file: string;
  line: number;
}

/** 扫描 `<Icon name="x">` / `<Icon name='x'>`；`name={expr}` 是动态值，交给 REQUIRED_ICONS 兜底。 */
function collectIconRefs(): IconRef[] {
  const refs: IconRef[] = [];
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(/<Icon\b[^>]*?\bname=["']([^"']+)["']/g)) {
      refs.push({
        name: match[1],
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        line: content.slice(0, match.index ?? 0).split(/\r?\n/).length,
      });
    }
  }
  return refs;
}

describe("本地图标库", () => {
  it("public/icons 下的每个 SVG 都是 1024 viewBox（与收录库一致，保证 mask 缩放不糊）", () => {
    const bad = svgFiles.filter((file) => {
      const content = fs.readFileSync(path.join(ICON_DIR, file), "utf8");
      return !/viewBox="0 0 1024 1024"/.test(content);
    });
    expect(bad, `这些图标不是 1024 viewBox：${bad.join(", ")}`).toEqual([]);
  });

  it("资产文件名只用 ASCII kebab-case，且不含大写/中文", () => {
    const bad = svgFiles.filter((file) => !/^[a-z0-9-]+\.svg$/.test(file));
    expect(bad, `不合规的图标文件名：${bad.join(", ")}`).toEqual([]);
  });

  it("关键规范图标一个都不能少（窗口/输入/状态/时间线）", () => {
    const missing = REQUIRED_ICONS.filter((name) => !svgNames.has(name));
    expect(missing, `缺少规范图标（public/icons）：${missing.join(", ")}`).toEqual([]);
  });

  it("所有 <Icon name=\"...\"> 静态引用都有同名 SVG", () => {
    const refs = collectIconRefs();
    expect(refs.length, "ui/src 里没有扫描到任何 <Icon> 引用，扫描逻辑可能已失效").toBeGreaterThan(0);
    const missing = refs.filter((ref) => !svgNames.has(ref.name));
    const detail = missing.map((ref) => `${ref.file}:${ref.line} -> ${ref.name}.svg`).join("\n");
    expect(missing, `引用了不存在的图标：\n${detail}`).toEqual([]);
  });

  it("ui/src 不再用 pictographic emoji 充当图标", () => {
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (EMOJI_RE.test(line)) {
          hits.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits, `发现 emoji 图标（请改用 <Icon name="...">）：\n${hits.join("\n")}`).toEqual([]);
  });
});
