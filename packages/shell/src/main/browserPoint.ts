/**
 * 坐标动作：视觉模型看截图后，用视口坐标点击。
 *
 * 为什么单独一层：
 *   · 现有 ref/CSS/text 点击是「先解析元素再点」，视觉模型只有像素坐标，没有 DOM target；
 *   · 坐标点击必须先 elementFromPoint 探测真实元素，敏感动作才能拿到可读文案做二次确认；
 *   · 截图可能是设备像素（DPR>1），坐标空间必须显式区分 CSS / image，避免点偏。
 *
 * 这里只产出页面脚本与纯结果；光标、权限、状态行仍由 browserTools 统一处理。
 */
import type { ScriptRunner } from "../browserAdapter/refs.js";

export type PointSpace = "css" | "image";

export interface PointProbeResult {
  ok: boolean;
  code?: "INVALID_ARGS" | "SCRIPT_ERROR" | "NO_TARGET";
  message?: string;
  /** 页面 CSS 视口坐标（真实输入事件使用）。 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tag?: string;
  role?: string;
  text?: string;
  /** 命中的元素是否具备可点击语义（a/button/input/[onclick]/[tabindex] 等）。 */
  clickable?: boolean;
  /** 命中框诊断（点偏时定位问题）。 */
  viewport?: { width: number; height: number };
  box?: { left: number; top: number; width: number; height: number };
  /** 实际使用的坐标空间与 DPR，便于诊断截图坐标换算。 */
  space?: PointSpace;
  dpr?: number;
}

export interface PointClickResult {
  ok: boolean;
  message?: string;
}

/**
 * 生成「坐标探测」脚本：不点击，只返回该点元素的坐标/尺寸/可读文案。
 * image 空间按 devicePixelRatio 换算；截图通常由 capturePage 以设备像素输出。
 */
export function buildPointProbeScript(x: number, y: number, space: PointSpace = "css"): string {
  return `/* loopsoar:point-probe */
(() => {
  const rawX = ${JSON.stringify(x)};
  const rawY = ${JSON.stringify(y)};
  const space = ${JSON.stringify(space)};
  const dpr = Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1;
  const px = space === 'image' ? rawX / dpr : rawX;
  const py = space === 'image' ? rawY / dpr : rawY;
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) {
    return { ok: false, code: 'INVALID_ARGS', message: '坐标越界：' + rawX + ',' + rawY + '（视口 ' + window.innerWidth + 'x' + window.innerHeight + '，space=' + space + '）' };
  }
  const cx = Math.min(Math.max(px, 0), Math.max(window.innerWidth - 1, 0));
  const cy = Math.min(Math.max(py, 0), Math.max(window.innerHeight - 1, 0));
  if (typeof document.elementFromPoint !== 'function') {
    return { ok: false, code: 'SCRIPT_ERROR', message: '页面不支持 elementFromPoint' };
  }
  const el = document.elementFromPoint(cx, cy);
  if (!el || el === document.documentElement || el === document.body) {
    return { ok: false, code: 'NO_TARGET', message: '坐标 (' + cx + ',' + cy + ') 没有可点击元素（命中页面空白）' };
  }
  const rect = el.getBoundingClientRect();
  const labelRaw = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '';
  const text = String(labelRaw).replace(/\\s+/g, ' ').trim().slice(0, 80);
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').trim().toLowerCase() || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
  const clickable = Boolean(el.matches && el.matches('a,button,input,textarea,select,summary,[role="button"],[role="link"],[onclick],[tabindex],[contenteditable="true"]'));
  return {
    ok: true,
    x: cx,
    y: cy,
    width: Math.max(rect.width, 2),
    height: Math.max(rect.height, 2),
    tag,
    role,
    ...(text ? { text } : {}),
    clickable,
    space,
    dpr,
    // 诊断上下文：点偏时能直接看出「视口多大、命中框在哪」，而不是只给一句「命中 div」。
    viewport: { width: window.innerWidth, height: window.innerHeight },
    box: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
})()`;
}

/** 执行坐标探测；脚本异常统一转 SCRIPT_ERROR，不让工具抛断整轮。 */
export async function performPointProbe(
  run: ScriptRunner,
  x: number,
  y: number,
  space: PointSpace = "css",
): Promise<PointProbeResult> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { ok: false, code: "INVALID_ARGS", message: `坐标不合法：${x},${y}` };
  }
  try {
    const raw = (await run(buildPointProbeScript(x, y, space))) as PointProbeResult | null;
    if (!raw || typeof raw !== "object") {
      return { ok: false, code: "SCRIPT_ERROR", message: "坐标探测没有返回结果" };
    }
    if (!raw.ok) {
      return { ...raw, code: raw.code ?? "SCRIPT_ERROR", message: raw.message ?? "坐标探测失败" };
    }
    if (typeof raw.x !== "number" || typeof raw.y !== "number") {
      return { ok: false, code: "SCRIPT_ERROR", message: "坐标探测返回了无效坐标" };
    }
    return raw;
  } catch (err) {
    return { ok: false, code: "SCRIPT_ERROR", message: `坐标探测脚本失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 降级点击脚本：真实 sendInputEvent 不可用（测试假件/旧后端）时按坐标派发 DOM click。 */
export function buildPointClickScript(x: number, y: number, space: PointSpace = "css"): string {
  return `/* loopsoar:point-click */
(() => {
  const rawX = ${JSON.stringify(x)};
  const rawY = ${JSON.stringify(y)};
  const space = ${JSON.stringify(space)};
  const dpr = Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1;
  const px = space === 'image' ? rawX / dpr : rawX;
  const py = space === 'image' ? rawY / dpr : rawY;
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) {
    return { ok: false, code: 'INVALID_ARGS', message: '坐标越界' };
  }
  const cx = Math.min(px, window.innerWidth - 1);
  const cy = Math.min(py, window.innerHeight - 1);
  const el = document.elementFromPoint(cx, cy);
  if (!el || el === document.documentElement || el === document.body) return { ok: false, code: 'NO_TARGET', message: '没有可点击元素' };
  // 富文本编辑器（UEditor 等）的编辑体在同源 iframe 里：iframe.click() 不会聚焦内层，
  // 需要把坐标换算进 frame 再点一次；跨域时保持原行为。
  if (el.tagName.toLowerCase() === 'iframe') {
    try {
      const doc = el.contentDocument;
      const rect = el.getBoundingClientRect();
      if (doc) {
        if (doc.body && typeof doc.body.focus === 'function') doc.body.focus();
        const inner = doc.elementFromPoint(cx - rect.left, cy - rect.top);
        if (inner && typeof inner.click === 'function') inner.click();
      }
    } catch (err) {}
  }
  el.click();
  return { ok: true };
})()`;
}

export async function performPointClick(
  run: ScriptRunner,
  x: number,
  y: number,
  space: PointSpace = "css",
): Promise<PointClickResult> {
  try {
    const raw = (await run(buildPointClickScript(x, y, space))) as { ok?: boolean; message?: string } | null;
    if (raw?.ok) return { ok: true };
    return { ok: false, message: raw?.message ?? "坐标点击失败" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
