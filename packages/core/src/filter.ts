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

// 对完整文本执行统一替换：将所有匹配的模型家族标记替换为「Loopsoar 平台」。
// 为什么：统一输出掩码是身份边界的最后一道防线，防止用户通过模型自称识别底层供应商。
export function applyOutputFilter(text: string): string {
  let result = text;
  for (const re of MODEL_FAMILY_RE) {
    result = result.replace(re, "Loopsoar 平台");
  }
  return result;
}

// 增量流过滤器：处理 LLM 流式输出（chunk）的跨边界正则匹配问题。
// 由于正则替换可能跨越多个 chunk，未完成的匹配尾部（如「底层模型」被切分）必须缓冲到下一个 chunk 再处理。
// 为什么：如果直接逐 chunk 替换，跨 chunk 的匹配会被漏掉（前半匹配不到完整模式，后半已丢失上下文），导致掩码失效。
export function createStreamFilter() {
  let buffer = "";

  return {
    /**
     * 接收一个文本 chunk，返回已过滤的安全文本。
     * 未完成的匹配尾部保留在内部 buffer，等待下次 push 完成匹配。
     */
    push(chunk: string): string {
      buffer += chunk;
      // 保守策略：最长可能跨边界的模式（如「底层模型」约 4 字符加上下文）取 20 字符缓冲。
      // 这样可以确保任何可能被切分的匹配都有足够上下文在下次处理时完成。
      const safeLen = Math.max(0, buffer.length - 20);
      const toProcess = buffer.slice(0, safeLen);
      buffer = buffer.slice(safeLen);
      return applyOutputFilter(toProcess);
    },

    /**
     * 流结束时刷新剩余 buffer，确保无遗漏。
     */
    flush(): string {
      const rest = applyOutputFilter(buffer);
      buffer = "";
      return rest;
    },
  };
}
