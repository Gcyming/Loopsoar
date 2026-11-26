/**
 * i18n 死键守卫：词典里定义了、但 packages/ui/src 中没有任何引用的 key 即死键。
 *
 * 为什么不只扫 t("key") / tr("key") 调用：本仓库大量 key 不是直接写在调用处，
 * 而是先存进数据表、再由 tr(key) 间接翻译，例如：
 *   · Settings.tsx 侧栏：tr(`settings.nav.${id}.label`)（模板拼接）；
 *   · Composer.tsx 权限类别：tr(category.labelKey)（labelKey 字段存字面量）；
 *   · AgentSidebar.tsx：localized("chat.sidebarCollapse", ...)。
 * 因此「引用」判定为下面任一成立（宁漏报、不误删）：
 *   1. 非词典源码里出现该 key 的完整字面量（双引号 / 单引号 / 反引号包裹）；
 *   2. 能被源码里模板字符串的前后缀动态拼出（如 settings.nav. 拼 .label），
 *      或字符串拼接的字面量片段拼出（如 "settings.nav." + id）。
 *
 * zh/en 一致性：i18nSettings / i18nBrowser 是 { zh, en } 成对结构；i18n.ts 内联
 * 词典分列两份，本用例额外断言两份 key 集合完全一致。
 *
 * 范围：i18n.ts（内联）+ i18nSettings.ts + i18nBrowser.ts + i18nChrome.ts。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const UI_SRC = path.join(ROOT, "packages/ui/src");

/** 词典文件本身不算「引用来源」（i18n*.ts）。 */
const DICT_FILE_PATTERN = /^i18n[^\/\\]*\.ts$/;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface InlineDict {
  zh: Set<string>;
  en: Set<string>;
}

/** i18n.ts 内联词典：分别解析 "zh-CN" / "en-US" 两个块（当前条目均为单行 key: "文案"）。 */
function parseInlineDict(src: string): InlineDict {
  const zh = new Set<string>();
  const en = new Set<string>();
  let mode: "zh" | "en" | null = null;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*"zh-CN"\s*:\s*\{/.test(line)) {
      mode = "zh";
      continue;
    }
    if (/^\s*"en-US"\s*:\s*\{/.test(line)) {
      mode = "en";
      continue;
    }
    if (mode && /^\s*\},\s*$/.test(line)) {
      mode = null;
      continue;
    }
    if (!mode) continue;
    const match = line.match(/^\s*"([^"]+)"\s*:\s*"/);
    if (match) (mode === "zh" ? zh : en).add(match[1]);
  }
  return { zh, en };
}

interface SplitDict {
  keys: Set<string>;
  missingLang: string[];
}

/** 拆分词典条目结构为 "key": { zh, en }（可能单行也可能多行），顺带检查 zh/en 是否成对。 */
function parseSplitDict(src: string): SplitDict {
  const keys = new Set<string>();
  const missingLang: string[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*"([^"]+)"\s*:\s*\{/);
    if (!match) continue;
    const key = match[1];
    keys.add(key);
    let block = lines[i];
    if (!/\{\s*zh\s*:/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j += 1) {
        block += "\n" + lines[j];
        if (/^\s*\},?\s*$/.test(lines[j])) {
          i = j;
          break;
        }
      }
    }
    if (!/zh\s*:/.test(block) || !/en\s*:/.test(block)) missingLang.push(key);
  }
  return { keys, missingLang };
}

const inline = parseInlineDict(fs.readFileSync(path.join(UI_SRC, "i18n.ts"), "utf8"));
const settings = parseSplitDict(fs.readFileSync(path.join(UI_SRC, "i18nSettings.ts"), "utf8"));
const browser = parseSplitDict(fs.readFileSync(path.join(UI_SRC, "i18nBrowser.ts"), "utf8"));
const chromePage = parseSplitDict(fs.readFileSync(path.join(UI_SRC, "i18nChrome.ts"), "utf8"));

const DICTS: Array<{ label: string; keys: Set<string> }> = [
  { label: "i18n.ts 内联词典", keys: new Set([...inline.zh, ...inline.en]) },
  { label: "SETTINGS_I18N", keys: settings.keys },
  { label: "BROWSER_I18N", keys: browser.keys },
  { label: "CHROME_PAGE_I18N", keys: chromePage.keys },
];

/** 所有非词典源码（packages/ui/src/**\/*.ts|tsx）的文本，作为「引用」证据来源。 */
const SOURCE_TEXTS = walkTsFiles(UI_SRC)
  .filter((file) => !DICT_FILE_PATTERN.test(path.basename(file)))
  .map((file) => fs.readFileSync(file, "utf8"));

function hasLiteralReference(key: string): boolean {
  return SOURCE_TEXTS.some(
    (src) =>
      src.includes('"' + key + '"') ||
      src.includes("'" + key + "'") ||
      src.includes("`" + key + "`"),
  );
}

interface DynamicPattern {
  prefix: string;
  suffix: string;
}

/**
 * 收集源码里的动态拼 key 模式：
 *   · 模板字符串取首尾静态片段（settings.nav.${id}.label → 前缀 settings.nav. / 后缀 .label）；
 *   · 字符串拼接取紧邻 + 的字面量片段（"settings.nav." + id → 前缀 settings.nav.）。
 */
function collectDynamicPatterns(src: string): DynamicPattern[] {
  const patterns: DynamicPattern[] = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== "`") continue;
    const parts: string[] = [];
    let current = "";
    let j = i + 1;
    let terminated = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === "\\") {
        current += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === "`") {
        j += 1;
        terminated = true;
        break;
      }
      if (ch === "$" && src[j + 1] === "{") {
        parts.push(current);
        current = "";
        let depth = 1;
        j += 2;
        while (j < src.length && depth > 0) {
          const inner = src[j];
          if (inner === '"' || inner === "'" || inner === "`") {
            const quote = inner;
            j += 1;
            while (j < src.length) {
              if (src[j] === "\\") {
                j += 2;
                continue;
              }
              if (src[j] === quote) {
                j += 1;
                break;
              }
              j += 1;
            }
            continue;
          }
          if (inner === "{") depth += 1;
          else if (inner === "}") depth -= 1;
          j += 1;
        }
        continue;
      }
      current += ch;
      j += 1;
    }
    parts.push(current);
    if (terminated && parts.length > 1) {
      patterns.push({ prefix: parts[0], suffix: parts[parts.length - 1] });
    }
    i = j - 1;
  }
  for (const match of src.matchAll(/(["'])([^"'\n]+)\1\s*\+/g)) {
    if (match[2].includes(".")) patterns.push({ prefix: match[2], suffix: "" });
  }
  for (const match of src.matchAll(/\+\s*(["'])([^"'\n]+)\1/g)) {
    if (match[2].includes(".")) patterns.push({ prefix: "", suffix: match[2] });
  }
  return patterns;
}

const DYNAMIC_PATTERNS = SOURCE_TEXTS.flatMap((src) => collectDynamicPatterns(src));

/** 动态拼接是否可能产出该 key：前缀按段边界匹配、后缀同理，避免 s${x} 这类普通拼接误判。 */
function isDynamicallyReferenced(key: string): boolean {
  return DYNAMIC_PATTERNS.some(({ prefix, suffix }) => {
    if (!prefix && !suffix) return false;
    if (prefix && !prefix.endsWith(".")) return false;
    if (suffix && !suffix.startsWith(".")) return false;
    return key.startsWith(prefix) && (suffix === "" || key.endsWith(suffix));
  });
}

function unreferencedKeys(keys: Set<string>): string[] {
  return [...keys].filter((key) => !hasLiteralReference(key) && !isDynamicallyReferenced(key)).sort();
}

describe("i18n 死键守卫", () => {
  it("扫描基线自检：防止解析失效后空断言假通过", () => {
    expect(SOURCE_TEXTS.length).toBeGreaterThanOrEqual(80);
    expect(inline.zh.size).toBeGreaterThanOrEqual(150);
    expect(inline.en.size).toBeGreaterThanOrEqual(150);
    expect(settings.keys.size).toBeGreaterThanOrEqual(400);
    expect(browser.keys.size).toBeGreaterThanOrEqual(150);
  });

  it("i18n.ts 内联词典 zh-CN / en-US key 集合一致", () => {
    const zhOnly = [...inline.zh].filter((key) => !inline.en.has(key)).sort();
    const enOnly = [...inline.en].filter((key) => !inline.zh.has(key)).sort();
    expect(zhOnly, "i18n.ts 内联词典 zh-CN 独有 key:\n" + zhOnly.join("\n")).toEqual([]);
    expect(enOnly, "i18n.ts 内联词典 en-US 独有 key:\n" + enOnly.join("\n")).toEqual([]);
  });

  it("拆分词典 SETTINGS_I18N / BROWSER_I18N 每条都同时提供 zh 与 en", () => {
    expect(settings.missingLang, "SETTINGS_I18N 缺少 zh/en 的条目:\n" + settings.missingLang.join("\n")).toEqual([]);
    expect(browser.missingLang, "BROWSER_I18N 缺少 zh/en 的条目:\n" + browser.missingLang.join("\n")).toEqual([]);
  });

  for (const dict of DICTS) {
    it(dict.label + " 不存在未引用的死键", () => {
      const dead = unreferencedKeys(dict.keys);
      expect(
        dead,
        "以下 key 在 packages/ui/src 中找不到引用（直接字面量或动态拼接）。\n" +
          "请删除词典条目，或在代码中恢复使用（动态拼接请用模板字符串；拼不出的可调整本守卫规则）:\n" +
          dead.join("\n"),
      ).toEqual([]);
    });
  }
});
