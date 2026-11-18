/** 办公文档 XML 的文本解码/清洗（无 DOM、无外部实体，避免 XXE/实体膨胀）。 */

/** 解码 XML 预定义实体与数字实体；非法码点降级为替换字符，绝不抛异常。 */
export function decodeXmlEntities(text: string): string {
  const codePoint = (raw: string, radix: 10 | 16): string => {
    const value = Number.parseInt(raw, radix);
    if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      return "\uFFFD";
    }
    try {
      return String.fromCodePoint(value);
    } catch {
      return "\uFFFD";
    }
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(dec, 10))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 统一换行/空白：去行尾空白、压缩 3+ 空行。 */
export function normalizeOfficeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
