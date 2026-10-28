/**
 * 导航 URL 校验（单一产地，纯函数）：UI 输入与主进程 navigate 处理器共用。
 * 为什么双层校验：渲染进程可能被注入，主进程不能假设入参已净化；
 * 只放行 http/https（拒绝 javascript:/file:/data:/about: 等可执行或本地读取协议）。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type NormalizeResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function normalizeNavigateUrl(input: string): NormalizeResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "空地址" };

  let candidate = raw;
  // 无 scheme 时按 https 补全（omnibox 语义）；有 scheme 一律严格校验
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    candidate = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: `无法解析为 URL：${raw}` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `仅允许 http/https（拒绝 ${parsed.protocol}）` };
  }
  if (!parsed.hostname) return { ok: false, reason: "缺少主机名" };
  return { ok: true, url: parsed.toString() };
}
