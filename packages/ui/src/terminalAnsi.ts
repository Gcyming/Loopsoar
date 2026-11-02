/**
 * 终端文本处理（纯函数，零依赖）：ANSI 转义剥离 / 终端语义规范化 / 行数上限。
 *
 * 为什么不用第三方：终端面板只需要「把子进程输出变成可读文本」这一小步，
 * 引 xterm.js 那样的大依赖会把 UI 包拖进 1MB+ 的渲染引擎；这里手写扫描器，
 * 覆盖 shell / Python / Node / 构建工具实际会吐出的控制序列即可。
 *
 * 处理链（TerminalPanel 里的顺序）：
 *   stripAnsi → normalizeTerminalText → limitLines
 * 三步都是纯函数，方便单测（tests/ui/terminalAnsi.spec.ts）。
 */

/** 终端输出区最多保留的行数（超过丢弃最早的行，防止长跑进程把内存撑爆）。 */
export const TERMINAL_MAX_LINES = 20000;

const ESC = 0x1b;
const BEL = 0x07;

/** 跳过 CSI 序列（ESC [ / C1 0x9B 之后）：参数字节 0x30-0x3F、中间字节 0x20-0x2F、终止字节 0x40-0x7E。 */
function skipCsi(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1; // 终止字节：序列结束
    if (code >= 0x20 && code <= 0x3f) {
      i++;
      continue;
    }
    return i; // 非法字节：不要把后面的普通文本一起吞掉
  }
  return n; // 不完整序列（输出被截断）：吞到结尾，避免半个控制串漏到界面
}

/** 跳过 OSC 序列（ESC ] / C1 0x9D 之后）：以 BEL 或 ST（ESC \）结尾。 */
function skipOsc(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === BEL) return i + 1;
    if (code === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2; // ST = ESC \
    i++;
  }
  return n;
}

/** 跳过以 ST（ESC \）结尾的字符串序列：DCS(ESC P) / SOS(ESC X) / PM(ESC ^) / APC(ESC _)。 */
function skipStString(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    if (text.charCodeAt(i) === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2;
    i++;
  }
  return n;
}

/** 跳过 ESC + 中间字节（0x20-0x2F）+ 终止字节的序列，例如 ESC ( B（字符集切换）、ESC # 8。 */
function skipEscIntermediate(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code <= 0x2f) {
      i++;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return i + 1; // 终止字节
    return i;
  }
  return n;
}

/**
 * 剥离 ANSI/终端控制序列，只保留可读文本。
 * 覆盖：CSI（颜色、光标、清屏）、OSC（标题、超链接）、DCS/SOS/PM/APC 字符串、
 * 双字节中间序列（ESC ( B 等）、单字符转义（ESC 7 / ESC 8 / ESC = / ESC > 等）。
 * 注意：不处理 \r / \b 等「文本语义」字符，那些交给 normalizeTerminalText。
 */
export function stripAnsi(text: string): string {
  if (!text) return "";
  const n = text.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 0x9b) {
      // C1 CSI（8 位形式，部分 Windows 控制台程序会吐）
      i = skipCsi(text, i + 1);
      continue;
    }
    if (code === 0x9d) {
      i = skipOsc(text, i + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      i = skipStString(text, i + 1);
      continue;
    }
    if (code !== ESC) {
      out += text[i];
      i++;
      continue;
    }
    // ESC：看下一个字节决定是哪种序列
    i++;
    if (i >= n) break; // 末尾孤立 ESC：直接丢弃
    const next = text.charCodeAt(i);
    if (next === 0x5b) {
      i = skipCsi(text, i + 1); // '[' CSI
    } else if (next === 0x5d) {
      i = skipOsc(text, i + 1); // ']' OSC
    } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      i = skipStString(text, i + 1); // P / X / ^ / _：字符串序列
    } else if (next >= 0x20 && next <= 0x2f) {
      i = skipEscIntermediate(text, i); // 中间字节序列（ESC ( B 等）
    } else {
      i++; // 单字符转义（ESC 7 / ESC 8 / ESC c / ESC M ...）
    }
  }
  return out;
}

/**
 * 把终端原始语义规范成可读文本：
 *   · \r\n → \n（跨平台输出统一换行）；
 *   · 单独 \r 视为「回到行首重写」，丢弃当前行已写内容（进度条原地刷新）；
 *   · \b 退格删除前一个字符（不跨行）；
 *   · 其余 C0 控制字符（BEL 等）与 DEL 丢弃，\t 保留。
 * 说明：不按列宽模拟光标（CJK 双宽字符），终端交互场景下足够。
 */
export function normalizeTerminalText(text: string): string {
  if (!text) return "";
  const src = text.replace(/\r\n/g, "\n");
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    if (ch === "\r") {
      line = ""; // 回车：光标回行首，后续字符覆盖当行
      continue;
    }
    if (ch === "\b") {
      // 退格：删掉行尾一个「字符」；代理对（emoji 等）要整体删，避免留下半个码元
      const lastCode = line.length > 0 ? line.charCodeAt(line.length - 1) : 0;
      const isLowSurrogate = lastCode >= 0xdc00 && lastCode <= 0xdfff;
      line = line.slice(0, isLowSurrogate && line.length >= 2 ? -2 : -1);
      continue;
    }
    const code = src.charCodeAt(i);
    if (code === 0x7f) continue; // DEL
    if (code < 0x20 && ch !== "\t") continue; // BEL 等其他控制字符
    line += ch;
  }
  lines.push(line);
  return lines.join("\n");
}

/**
 * 只保留最后 maxLines 行（超过上限丢弃最早的行）。
 * maxLines <= 0 或非法值时返回空串；行数未超时原样返回（保留末尾换行等细节）。
 */
export function limitLines(text: string, maxLines: number): string {
  if (!text) return "";
  if (!Number.isFinite(maxLines) || maxLines <= 0) return "";
  const cap = Math.floor(maxLines);
  if (cap <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= cap) return text;
  return lines.slice(lines.length - cap).join("\n");
}
