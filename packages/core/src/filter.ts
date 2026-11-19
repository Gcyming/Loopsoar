/**
 * 模型输出过滤（§4.1 filter）
 * MODEL_FAMILY_RE 识别主流模型家族自称模式，统一替换为「Loopsoar 平台」；
 * applyOutputFilter 对完整文本执行替换；createStreamFilter 处理流式输出的跨 chunk 边界匹配问题。
 * 为什么：不同模型对自身身份描述不一，若不统一掩码，用户可见输出将泄露底层模型信息，破坏平台身份边界。
 */

// 模型家族正则表：覆盖 GPT/Claude/Gemini/Qwen/DeepSeek/Kimi/GLM/Llama 及常见中文 AI 自称模式。
// 为什么：每个家族有独特的自称句式（如「我是由 OpenAI 开发的大型语言模型」），必须逐一匹配才能彻底掩码。
export const MODEL_FAMILY_RE: readonly RegExp[] = [
  // GPT 系列
  /(?:\b(?:I am|I'm)\s+(?:a\s+)?(?:large\s+)?language\s+model\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+OpenAI\b)/gi,
  /(?:\bOpenAI\b)/gi,
  /(?:\bGPT[- ]?\d(?:\.\d)?\b)/gi,
  // Claude 系列
  /(?:\b(?:trained by|developed by|created by)\s+Anthropic\b)/gi,
  /(?:\bAnthropic\b)/gi,
  /(?:\bClaude\b)/gi,
  // Gemini 系列
  /(?:\b(?:trained by|developed by|created by)\s+Google\b)/gi,
  /(?:\bGemini\b)/gi,
  // Qwen 系列
  /(?:\bQwen\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+Alibaba\b)/gi,
  // DeepSeek 系列
  /(?:\bDeepSeek\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+DeepSeek\b)/gi,
  // Kimi 系列
  /(?:\bKimi\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+Moonshot\b)/gi,
  // GLM 系列
  /(?:\bGLM\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+Zhipu\b)/gi,
  // Llama 系列
  /(?:\bLlama\b)/gi,
  /(?:\b(?:trained by|developed by|created by)\s+Meta\b)/gi,
  // 中文通用 AI 自称
  /作为一个\s*AI\s*(?:助手|模型|程序)/gi,
  /我是\s*语言\s*模型/gi,
  /底层\s*模型/gi,
] as const;

interface ProtectedRange {
  start: number;
  end: number;
}

/** 收集受保护区间；重叠区间合并，保证每个字符最多被保护一次。 */
function protectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const add = (start: number, end: number): void => {
    if (end > start) ranges.push({ start, end });
  };

  // 围栏代码块：未闭合时保护到文本末尾（宁可少掩码，也不改坏代码）。
  const fence = /```[\s\S]*?(?:```|$)/g;
  for (const match of text.matchAll(fence)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length);
  }

  // 行内代码：只保护单行；跳过已落在围栏里的区间。
  const inline = /`[^`\n]*`/g;
  for (const match of text.matchAll(inline)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (ranges.some((r) => start < r.end && end > r.start)) continue;
    add(start, end);
  }

  // URL：保留协议到路径/查询；中文正文紧贴 URL 时在 CJK 字符处截断。
  const url = /https?:\/\/[^\s<>"'`\u4e00-\u9fff]+/gi;
  for (const match of text.matchAll(url)) {
    const raw = match[0].replace(/[),.;:!?，。；：！？、]+$/, "");
    if (!raw) continue;
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (ranges.some((r) => start < r.end && end > r.start)) continue;
    add(start, end);
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: ProtectedRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function mask(text: string): string {
  let result = text;
  for (const re of MODEL_FAMILY_RE) result = result.replace(re, "Loopsoar 平台");
  return result;
}

// 对完整文本执行替换：受保护区间原样保留，普通文本掩码。
export function applyOutputFilter(text: string): string {
  if (!text) return text;
  const ranges = protectedRanges(text);
  if (ranges.length === 0) return mask(text);
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += mask(text.slice(cursor, range.start));
    out += text.slice(range.start, range.end);
    cursor = range.end;
  }
  out += mask(text.slice(cursor));
  return out;
}

// 增量流过滤器：按完整行处理，维护围栏开/关状态。
// 为什么按行而不是固定 20 字符尾巴：固定尾巴仍可能把 URL/行内代码切断；按行处理能保证
// 围栏代码块内的内容不被误掩码。没有换行的尾块留到 flush。
export function createStreamFilter() {
  let buffer = "";
  let inFence = false;

  return {
    push(chunk: string): string {
      buffer += chunk;
      let out = "";
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          out += line;
        } else {
          out += inFence ? line : applyOutputFilter(line);
        }
      }
      return out;
    },

    flush(): string {
      const rest = applyOutputFilter(buffer);
      buffer = "";
      inFence = false;
      return rest;
    },
  };
}
