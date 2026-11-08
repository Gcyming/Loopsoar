/**
 * SVG 图形包围盒（bbox）纯函数库 —— 图标居中检查与守卫测试共用。
 *
 * 为什么不用 Electron Canvas 求 alpha bbox：本机（Windows dev / 沙箱会话）Electron
 * 直接启动测图脚本时 Chromium 进程会以 0x80000003 崩溃（见 scripts/dev-gui.mjs 注释），
 * Canvas 方案不可移植。这里改为解析 SVG 几何（path/rect/circle/polygon…，曲线采样），
 * 对手绘图标而言得到的可见图形 bbox 与 alpha bbox 等价（误差 < 1%）：
 *   · 有 fill 的元素：bbox = 几何 bbox；
 *   · fill:none + stroke 的线条图标：bbox 再按 stroke-width/2 外扩；
 *   · 曲线按 24 段采样，避免用控制点包围盒把圆角放大。
 */

const PATH_TOKEN_RE = /([astvzqmhlcASTVZQMHLC])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;

/** 解析 transform 属性为 [a,b,c,d,e,f] 矩阵（与 SVG 的 column-major 约定一致）。 */
export function parseTransform(value) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!value) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(value))) {
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    const name = match[1].toLowerCase();
    let next;
    if (name === "matrix") next = args;
    else if (name === "translate") next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    else if (name === "scale") next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (name === "rotate") {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      next = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
    } else if (name === "skewx") next = [1, 0, Math.tan((((args[0] ?? 0) * Math.PI) / 180)), 1, 0, 0];
    else next = [1, Math.tan((((args[0] ?? 0) * Math.PI) / 180)), 0, 1, 0, 0];
    m = multiply(next, m);
  }
  return m;
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function emptyBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function addPoint(box, x, y) {
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
}

function addBox(box, other) {
  if (!Number.isFinite(other.minX)) return;
  addPoint(box, other.minX, other.minY);
  addPoint(box, other.maxX, other.maxY);
}

const SIZE = 1024;
const CURVE_STEPS = 24;

/** 把 d 属性解析成绝对坐标下的折线点（曲线采样），返回 {points, closed}。 */
export function parsePathData(d) {
  const tokens = [];
  const re = new RegExp(PATH_TOKEN_RE.source, "gi");
  let m;
  while ((m = re.exec(d))) tokens.push(m[1] ?? Number(m[2]));
  const points = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let prevCtrlX = 0;
  let prevCtrlY = 0;
  let prevCmd = "";
  const num = () => Number(tokens[i++]);
  const isNum = () => typeof tokens[i] === "number" || (typeof tokens[i] === "string" && /^[-\d.]/.test(tokens[i]));
  const push = (px, py) => addPointPoints(points, px, py);
  const addPointPoints = (list, px, py) => {
    list.push(px, py);
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    for (let s = 1; s <= CURVE_STEPS; s += 1) {
      const t = s / CURVE_STEPS;
      const mt = 1 - t;
      const px = mt ** 3 * x + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
      const py = mt ** 3 * y + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
      push(px, py);
    }
    prevCtrlX = x2;
    prevCtrlY = y2;
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (typeof token === "string" && /[a-z]/i.test(token)) {
      cmd = token;
      i += 1;
      if (cmd.toUpperCase() === "Z") {
        x = startX;
        y = startY;
        push(x, y);
        prevCtrlX = x;
        prevCtrlY = y;
        prevCmd = "Z";
        continue;
      }
    } else if (!cmd) {
      i += 1;
      continue;
    }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    if (C === "M") {
      const abs = [num(), num()];
      x = rel ? x + abs[0] : abs[0];
      y = rel ? y + abs[1] : abs[1];
      startX = x;
      startY = y;
      push(x, y);
      prevCtrlX = x;
      prevCtrlY = y;
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      const abs = [num(), num()];
      x = rel ? x + abs[0] : abs[0];
      y = rel ? y + abs[1] : abs[1];
      push(x, y);
      prevCtrlX = x;
      prevCtrlY = y;
    } else if (C === "H") {
      const v = num();
      x = rel ? x + v : v;
      push(x, y);
      prevCtrlX = x;
      prevCtrlY = y;
    } else if (C === "V") {
      const v = num();
      y = rel ? y + v : v;
      push(x, y);
      prevCtrlX = x;
      prevCtrlY = y;
    } else if (C === "C") {
      const c1x = rel ? x + num() : num();
      const c1y = rel ? y + num() : num();
      const c2x = rel ? x + num() : num();
      const c2y = rel ? y + num() : num();
      const ex = rel ? x + num() : num();
      const ey = rel ? y + num() : num();
      cubic(c1x, c1y, c2x, c2y, ex, ey);
      x = ex;
      y = ey;
    } else if (C === "S") {
      const c2x = rel ? x + num() : num();
      const c2y = rel ? y + num() : num();
      const ex = rel ? x + num() : num();
      const ey = rel ? y + num() : num();
      const smooth = prevCmd === "C" || prevCmd === "S";
      const c1x = smooth ? 2 * x - prevCtrlX : x;
      const c1y = smooth ? 2 * y - prevCtrlY : y;
      cubic(c1x, c1y, c2x, c2y, ex, ey);
      x = ex;
      y = ey;
    } else if (C === "Q") {
      const c1x = rel ? x + num() : num();
      const c1y = rel ? y + num() : num();
      const ex = rel ? x + num() : num();
      const ey = rel ? y + num() : num();
      const c2x = x + (2 / 3) * (c1x - x);
      const c2y = y + (2 / 3) * (c1y - y);
      const c3x = ex + (2 / 3) * (c1x - ex);
      const c3y = ey + (2 / 3) * (c1y - ey);
      cubic(c2x, c2y, c3x, c3y, ex, ey);
      x = ex;
      y = ey;
    } else if (C === "T") {
      const ex = rel ? x + num() : num();
      const ey = rel ? y + num() : num();
      const smooth = prevCmd === "Q" || prevCmd === "T";
      const c1x = smooth ? 2 * x - prevCtrlX : x;
      const c1y = smooth ? 2 * y - prevCtrlY : y;
      const c2x = x + (2 / 3) * (c1x - x);
      const c2y = y + (2 / 3) * (c1y - y);
      const c3x = ex + (2 / 3) * (c1x - ex);
      const c3y = ey + (2 / 3) * (c1y - ey);
      cubic(c2x, c2y, c3x, c3y, ex, ey);
      x = ex;
      y = ey;
    } else if (C === "A") {
      const rx = Math.abs(num());
      const ry = Math.abs(num());
      const rotation = num();
      const large = num();
      const sweep = num();
      const ex = rel ? x + num() : num();
      const ey = rel ? y + num() : num();
      // 椭圆弧按标准参数化采样（端点 → 中心），足够做包围盒。
      const phi = (rotation * Math.PI) / 180;
      const dx = (x - ex) / 2;
      const dy = (y - ey) / 2;
      const x1p = Math.cos(phi) * dx + Math.sin(phi) * dy;
      const y1p = -Math.sin(phi) * dx + Math.cos(phi) * dy;
      const rx2 = rx * rx;
      const ry2 = ry * ry;
      const lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
      const scale = lambda > 1 ? Math.sqrt(lambda) : 1;
      const ax = rx * scale;
      const ay = ry * scale;
      const sign = large === sweep ? -1 : 1;
      const coef = sign * Math.sqrt(Math.max(0, (ax * ax * ay * ay - ax * ax * y1p * y1p - ay * ay * x1p * x1p) / (ax * ax * y1p * y1p + ay * ay * x1p * x1p)));
      const cxp = (coef * (ax * y1p)) / ay;
      const cyp = (coef * -(ay * x1p)) / ax;
      const cx = Math.cos(phi) * cxp - Math.sin(phi) * cyp + (x + ex) / 2;
      const cy = Math.sin(phi) * cxp + Math.cos(phi) * cyp + (y + ey) / 2;
      const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const startAngle = angle(1, 0, (x1p - cxp) / ax, (y1p - cyp) / ay);
      const endAngle = angle(1, 0, (-x1p - cxp) / ax, (-y1p - cyp) / ay);
      let delta = endAngle - startAngle;
      if (sweep && delta < 0) delta += 2 * Math.PI;
      if (!sweep && delta > 0) delta -= 2 * Math.PI;
      for (let s = 1; s <= CURVE_STEPS; s += 1) {
        const th = startAngle + (delta * s) / CURVE_STEPS;
        const px = cx + ax * Math.cos(th) * Math.cos(phi) - ay * Math.sin(th) * Math.sin(phi);
        const py = cy + ax * Math.cos(th) * Math.sin(phi) + ay * Math.sin(th) * Math.cos(phi);
        push(px, py);
      }
      x = ex;
      y = ey;
      prevCtrlX = x;
      prevCtrlY = y;
    } else {
      // 未知命令：跳过参数，避免死循环
      i += 1;
      continue;
    }
    prevCmd = C;
  }
  return points;
}

function pathBox(d) {
  const points = parsePathData(d);
  const box = emptyBox();
  for (let k = 0; k < points.length; k += 2) addPoint(box, points[k], points[k + 1]);
  return box;
}

function pointsBox(pointsStr) {
  const nums = (pointsStr.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const box = emptyBox();
  for (let k = 0; k + 1 < nums.length; k += 2) addPoint(box, nums[k], nums[k + 1]);
  return box;
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : "";
}

function transformBox(box, m) {
  if (!Number.isFinite(box.minX)) return box;
  const next = emptyBox();
  for (const [px, py] of [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ]) {
    const [tx, ty] = apply(m, px, py);
    addPoint(next, tx, ty);
  }
  return next;
}

/**
 * 计算 SVG 文本中可见图形的包围盒（viewBox 单位）。
 * 返回 { minX, minY, maxX, maxY, viewBox }；没有可解析图形时返回 null。
 */
export function computeSvgBBox(svgText) {
  const vbMatch = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(svgText);
  const viewBox = vbMatch
    ? { x: Number(vbMatch[1]), y: Number(vbMatch[2]), width: Number(vbMatch[3]), height: Number(vbMatch[4]) }
    : { x: 0, y: 0, width: SIZE, height: SIZE };
  const box = emptyBox();
  const stack = [[1, 0, 0, 1, 0, 0]];
  const tagRe = /<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let match;
  while ((match = tagRe.exec(svgText))) {
    const full = match[0];
    const name = match[1].toLowerCase();
    if (full.startsWith("</")) {
      if (name === "g" && stack.length > 1) stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    const local = parseTransform(attr(full, "transform"));
    const m = multiply(parent, local);
    if (name === "g") {
      if (!full.endsWith("/>")) stack.push(m);
      continue;
    }
    const strokeWidth = Number(attr(full, "stroke-width")) || 0;
    const hasStroke = attr(full, "stroke") && attr(full, "stroke") !== "none" && strokeWidth > 0;
    const hasFill = attr(full, "fill") !== "none";
    const pad = hasStroke && !hasFill ? strokeWidth / 2 : 0;
    let localBox = null;
    if (name === "path" && attr(full, "d")) localBox = pathBox(attr(full, "d"));
    else if (name === "rect") {
      const x = Number(attr(full, "x")) || 0;
      const y = Number(attr(full, "y")) || 0;
      const w = Number(attr(full, "width")) || 0;
      const h = Number(attr(full, "height")) || 0;
      if (w > 0 && h > 0) localBox = { minX: x, minY: y, maxX: x + w, maxY: y + h };
    } else if (name === "circle") {
      const cx = Number(attr(full, "cx")) || 0;
      const cy = Number(attr(full, "cy")) || 0;
      const r = Number(attr(full, "r")) || 0;
      if (r > 0) localBox = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    } else if (name === "ellipse") {
      const cx = Number(attr(full, "cx")) || 0;
      const cy = Number(attr(full, "cy")) || 0;
      const rx = Number(attr(full, "rx")) || 0;
      const ry = Number(attr(full, "ry")) || 0;
      if (rx > 0 && ry > 0) localBox = { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
    } else if (name === "polygon" || name === "polyline") {
      if (attr(full, "points")) localBox = pointsBox(attr(full, "points"));
    } else if (name === "line") {
      const x1 = Number(attr(full, "x1")) || 0;
      const y1 = Number(attr(full, "y1")) || 0;
      const x2 = Number(attr(full, "x2")) || 0;
      const y2 = Number(attr(full, "y2")) || 0;
      localBox = { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
    }
    if (!localBox || !Number.isFinite(localBox.minX)) continue;
    if (pad > 0) localBox = { minX: localBox.minX - pad, minY: localBox.minY - pad, maxX: localBox.maxX + pad, maxY: localBox.maxY + pad };
    addBox(box, transformBox(localBox, m));
  }
  if (!Number.isFinite(box.minX)) return null;
  return { ...box, viewBox };
}

/** bbox 中心相对 viewBox 中心的偏移（百分比，正数 = 偏右下）。 */
export function centerOffset(bbox) {
  const vb = bbox.viewBox;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  return {
    dx: ((cx - (vb.x + vb.width / 2)) / vb.width) * 100,
    dy: ((cy - (vb.y + vb.height / 2)) / vb.height) * 100,
  };
}
