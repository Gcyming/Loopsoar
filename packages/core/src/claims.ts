/**
 * 声称核验（§4.1 claims）
 * 识别模型输出中对文件操作的「声称」，提取路径并核验真实存在性，防止编造结果。
 * 跳过 fenced code block（代码示例不应触发核验）、跳过 URL/域名残片，
 * 对提取路径调用外部注入的 exists 回调进行异步核验。
 * 为什么：模型经常声称「已保存」但实际未执行，必须在每轮输出后自动核验，构成安全闭环。
 */

// 声称动词白名单：只有这些中文「已完成」类动词才触发核验。
// 为什么：模糊表述（如「尝试写入」）不触发声称核验，因为它们没有明确承诺已完成操作。
export const CLAIM_VERBS: readonly string[] = [
  "已保存",
  "已生成",
  "已创建",
  "已写入",
  "已下载",
  "已导出",
  "保存到",
] as const;

// 路径扩展名白名单（60+ 常见文件类型）：只有这些后缀的路径才被提取核验。
// 为什么：避免对 URL 残片、伪路径或非文件操作产生误报，同时覆盖实际工程中常见的文件类型。
export const PATH_EXTENSIONS: readonly string[] = [
  "txt", "md", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "csv", "tsv",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "java", "kt", "kts",
  "go", "rs", "rb", "php",
  "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "swift",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
  "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
  "mp3", "mp4", "wav", "avi", "mov", "mkv", "webm", "ogg", "flac",
  "zip", "tar", "gz", "rar", "7z", "pdf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "lock", "env", "gitignore", "dockerignore", "editorconfig",
  "sql", "db", "sqlite", "log",
] as const;

// 路径提取正则：匹配带扩展名的文件路径字符串（允许字母、数字、下划线、点、斜杠、连字符、盘符冒号）。
const PATH_RE = new RegExp(
  `[A-Za-z0-9_./\\\\:-]+\\.(?:${PATH_EXTENSIONS.join("|")})\\b`,
  "gi",
);

/**
 * 核验发现项
 */
export interface ClaimFinding {
  claim: string;         // 原始声称文本片段
  path: string;          // 提取的路径
  verb: string;          // 使用的声称动词
  exists: boolean;       // exists 回调返回的真实存在状态
  verified: boolean;     // 是否完成核验（true=已调用 exists 且无异常）
  reason?: string;       // 核验备注（如跳过代码块、URL 残片、异常信息）
}

// 判断文本中某个索引位置是否位于 fenced code block（```...```）内部。
// 为什么：代码块中的「已保存」通常是代码示例，不是实际文件操作声称，必须排除以避免误报。
function inFencedCodeBlock(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const backticks = before.match(/```/g);
  return backticks ? (backticks.length % 2 === 1) : false;
}

// 判断字符串是否像 URL/域名残片（含协议头或典型顶级域格式）。
// 为什么：模型输出中常出现「已保存到 https://example.com/file」这类残片，不应被当作真实本地路径核验。
function looksLikeUrlFragment(candidate: string): boolean {
  // 不能把「report.md / README.md」这类纯文件名当 URL 残片：否则最常见的
  // 「已保存到 report.md」声称永远被跳过，诚实协议的核验闭环直接失效。
  // 只有带协议头、带 www. 前缀、或域名后确实跟着路径分隔符，才按 URL 残片处理。
  return (
    /^https?:\/\//i.test(candidate) ||
    /^www\./i.test(candidate) ||
    /(?:^|\s)(?:www\.)?[A-Za-z0-9-]+\.[A-Za-z]{2,}\//.test(candidate)
  );
}

/**
 * 审计文本中的操作声称：提取路径并调用外部注入的 exists 回调进行核验。
 * @param text 要审计的模型输出文本
 * @param exists 异步路径存在性检查（由调用方注入，通常走 platform.fs.exists）
 */
export async function auditClaims(
  text: string,
  exists: (p: string) => Promise<boolean>,
): Promise<ClaimFinding[]> {
  const findings: ClaimFinding[] = [];

  // 构造声称动词匹配模式
  const escapedVerbs = CLAIM_VERBS.map((v) =>
    v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const verbPattern = new RegExp(escapedVerbs.join("|"), "g");

  let match: RegExpExecArray | null;
  while ((match = verbPattern.exec(text)) !== null) {
    const verb = match[0];
    const verbIndex = match.index;

    // 跳过代码块内的声称（代码示例不触发核验）
    if (inFencedCodeBlock(text, verbIndex)) {
      continue;
    }

    // 提取动词前后各 200 字符窗口，查找路径
    const windowStart = Math.max(0, verbIndex - 200);
    const windowEnd = Math.min(text.length, verbIndex + 200);
    const windowText = text.slice(windowStart, windowEnd);

    const pathMatches = windowText.match(PATH_RE) || [];
    for (const rawPath of pathMatches) {
      const path = rawPath.trim();

      // 跳过 URL/域名残片
      if (looksLikeUrlFragment(path)) {
        findings.push({
          claim: text.slice(
            Math.max(0, verbIndex - 50),
            Math.min(text.length, verbIndex + 100),
          ),
          path,
          verb,
          exists: false,
          verified: false,
          reason: "跳过 URL/域名残片",
        });
        continue;
      }

      // 再次检查路径在原文中的位置是否在代码块内
      const absPathIndex = text.indexOf(path, Math.max(0, verbIndex - 200));
      if (absPathIndex !== -1 && inFencedCodeBlock(text, absPathIndex)) {
        continue;
      }

      let existsResult = false;
      let verified = false;
      let reason: string | undefined;

      try {
        existsResult = await exists(path);
        verified = true;
      } catch (err) {
        existsResult = false;
        verified = false;
        reason = err instanceof Error ? err.message : String(err);
      }

      findings.push({
        claim: text.slice(
          Math.max(0, verbIndex - 50),
          Math.min(text.length, verbIndex + 100),
        ),
        path,
        verb,
        exists: existsResult,
        verified,
        reason,
      });
    }
  }

  return findings;
}
