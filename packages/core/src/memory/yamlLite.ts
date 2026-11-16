/**
 * 迷你 YAML 子集（yaml-lite）：记忆 frontmatter 只需要「标量 / 标量列表 / 嵌套一层 map /
 * map 列表」四种形状，没必要为一个字段引入第三方 YAML 解析器（还会在 Electron 主进程
 * 打包时踩到 CJS require("process") 的坑）。
 *
 * 约定：
 *  - 我们只 emit 自己 parser 能读回的子集，有测试保证 round-trip；
 *  - parser 尽力兼容常见手写（引号、flow 列表、块列表、注释、CRLF），看不懂就返回 null，
 *    由调用方跳过该文件并告警——绝不把错误数据写回库。
 */

export class YamlLiteError extends Error {}

type Scalar = string | number | boolean | null;
type Value = Scalar | Value[] | { [key: string]: Value };

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ .\/-]*$/;

function quote(text: string): string {
  return JSON.stringify(text);
}

function emitScalar(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (text(value) === "") return '""';
  return PLAIN.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value) ? value : quote(value);
}

function text(value: string): string {
  return value;
}

function isMap(value: Value): value is { [key: string]: Value } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitValue(value: Value, indent: number): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return " []";
    if (value.every((item) => !isMap(item) && !Array.isArray(item))) {
      return " [" + value.map((item) => emitScalar(item as Scalar)).join(", ") + "]";
    }
    const lines = [""];
    for (const item of value) {
      if (isMap(item)) {
        const entries = Object.entries(item);
        entries.forEach(([key, child], index) => {
          const prefix = index === 0 ? pad + "- " : pad + "  ";
          lines.push(prefix + key + ":" + emitValue(child, indent + 4));
        });
      } else {
        lines.push(pad + "- " + emitScalar(item as Scalar));
      }
    }
    return lines.join("\n");
  }
  if (isMap(value)) {
    const lines = [""];
    for (const [key, child] of Object.entries(value)) {
      lines.push(pad + key + ":" + emitValue(child, indent + 2));
    }
    return lines.join("\n");
  }
  return " " + emitScalar(value as Scalar);
}

/** 序列化 frontmatter 对象（不带 --- 分隔符）。键顺序按插入顺序，保证两次输出一致。 */
export function dumpYaml(value: { [key: string]: unknown }): string {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    lines.push(key + ":" + emitValue(child as Value, 2));
  }
  return lines.join("\n");
}

function parseScalar(raw: string): Scalar {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new YamlLiteError("双引号字符串未闭合或含非法转义");
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** 解析 flow 列表 [a, "b", 'c']（只在顶层逗号切分，尊重引号）。 */
function parseFlowList(raw: string): Scalar[] {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === "") return [];
  const parts: string[] = [];
  let current = "";
  let quoteChar: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string;
    if (quoteChar) {
      current += ch;
      if (ch === quoteChar && inner[i - 1] !== "\\") quoteChar = null;
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(parseScalar);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function stripComment(line: string): string {
  // 只处理「行首注释」与「空白后 #」，引号内的 # 不动
  let quoteChar: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoteChar) {
      if (ch === quoteChar && line[i - 1] !== "\\") quoteChar = null;
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

class Parser {
  private lines: { indent: number; text: string }[] = [];

  constructor(source: string) {
    for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
      const line = stripComment(rawLine);
      if (!line.trim()) continue;
      this.lines.push({ indent: indentOf(line), text: line.trim() });
    }
  }

  parse(): { [key: string]: Value } {
    if (this.lines.length === 0) return {};
    const { value, index } = this.parseBlock(0, this.lines[0]?.indent ?? 0);
    if (index !== this.lines.length) throw new YamlLiteError("frontmatter 结构无法解析（缩进或嵌套不合法）");
    if (!isMap(value)) throw new YamlLiteError("frontmatter 顶层必须是映射");
    return value;
  }

  private parseBlock(start: number, indent: number): { value: Value; index: number } {
    const first = this.lines[start];
    if (!first) throw new YamlLiteError("空的 frontmatter");
    return first.text.startsWith("- ") || first.text === "-"
      ? this.parseList(start, indent)
      : this.parseMap(start, indent);
  }

  private parseList(start: number, indent: number): { value: Value; index: number } {
    const items: Value[] = [];
    let i = start;
    while (i < this.lines.length) {
      const line = this.lines[i] as { indent: number; text: string };
      if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;
      const rest = line.text.slice(2).trim();
      if (rest === "") {
        const child = this.parseBlock(i + 1, indent + 2);
        items.push(child.value);
        i = child.index;
        continue;
      }
      const colon = rest.indexOf(":");
      if (colon > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
        // map 列表项：- key: value 后续更深缩进的行属于同一个 map
        const entry: { [key: string]: Value } = {};
        const key = rest.slice(0, colon).trim();
        const tail = rest.slice(colon + 1).trim();
        entry[key] = tail === "" ? null : this.parseInline(tail);
        i += 1;
        while (i < this.lines.length) {
          const next = this.lines[i] as { indent: number; text: string };
          if (next.indent <= indent) break;
          const sep = next.text.indexOf(":");
          if (sep <= 0) throw new YamlLiteError(`无法解析列表项的字段：${next.text}`);
          const childKey = next.text.slice(0, sep).trim();
          const childTail = next.text.slice(sep + 1).trim();
          entry[childKey] = childTail === "" ? null : this.parseInline(childTail);
          i += 1;
        }
        items.push(entry);
        continue;
      }
      items.push(this.parseInline(rest));
      i += 1;
    }
    return { value: items, index: i };
  }

  private parseMap(start: number, indent: number): { value: Value; index: number } {
    const map: { [key: string]: Value } = {};
    let i = start;
    while (i < this.lines.length) {
      const line = this.lines[i] as { indent: number; text: string };
      if (line.indent !== indent) break;
      const sep = line.text.indexOf(":");
      if (sep <= 0) throw new YamlLiteError(`无法解析行：${line.text}`);
      const key = line.text.slice(0, sep).trim();
      const tail = line.text.slice(sep + 1).trim();
      if (tail === "") {
        const next = this.lines[i + 1];
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) {
          const child = this.parseBlock(i + 1, next.indent);
          map[key] = child.value;
          i = child.index;
        } else {
          map[key] = null;
          i += 1;
        }
        continue;
      }
      map[key] = this.parseInline(tail);
      i += 1;
    }
    return { value: map, index: i };
  }

  private parseInline(raw: string): Value {
    if (raw.startsWith("[") && raw.endsWith("]")) return parseFlowList(raw);
    if (raw.startsWith("{") && raw.endsWith("}")) {
      const map: { [key: string]: Value } = {};
      for (const part of raw.slice(1, -1).split(",")) {
        const sep = part.indexOf(":");
        if (sep <= 0) throw new YamlLiteError("无法解析 flow map");
        map[part.slice(0, sep).trim()] = parseScalar(part.slice(sep + 1));
      }
      return map;
    }
    return parseScalar(raw);
  }
}

/** 解析 frontmatter（不带 --- 分隔符）。失败抛 YamlLiteError，调用方应跳过该文件。 */
export function parseYamlLite(source: string): { [key: string]: Value } {
  return new Parser(source).parse();
}
