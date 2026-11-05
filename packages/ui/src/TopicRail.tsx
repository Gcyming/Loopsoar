/**
 * TopicRail —— slime 卷轴（TopicRail wave 模式）的 Loopsoar 移植版。
 *
 * 视觉目标（对齐 slime 实拍，颜色改用 Loopsoar 主题）：**双股编织麻花**贯穿整条高度 ——
 *   - 主股：`244,239,230`（亚麻白，Loopsoar 品牌亮色），宽 `W*0.13`，视口位置之上最亮、之下转暗；
 *   - 辅股：`216,141,86`（赭石暖色，取自品牌 ochre），宽 `W*0.095`，相位差 π、反向摆动，与主股交织；
 *   - 两股各自再描一遍更宽、更低透明度的「光晕」，形成细而发光的效果；
 *   - 两股波长接近（默认 46 / 53），形成缓慢的编织节奏，而不是散开的乱线。
 *
 * 配色约束：只使用 Loopsoar 品牌色（亚麻白 / 赭石 / 暖金），不复刻 slime 的蓝白配色。
 *
 * 悬停反馈（slime 的「突起」）：指针高度处两股**收拢**并整体向聊天区一侧鼓出，
 * 中心用高斯「bulge」、两翼用「dip」做回弹，形成平滑的单峰鼓包；离开后缓动收回。
 * 画布向左多留 `LEFT_ROOM` 空间，鼓包不会被裁切。
 *
 * 与 slime 的对应关系：
 *   - 几何 / 配色 / alpha / 光晕宽度 / 线宽比例逐项照搬
 *     slime 渲染层 `pages/TopicRail.tsx` 的 wave 模式（几何/比例逐项对齐，不复制其配色）；
 *   - 参数（波长/振幅/速度/渐隐）可在外观设置页调整，存 localStorage 并事件广播；
 *   - 去掉 slime 的「刻度模式」；话题锚点只用于悬停卡片文案，不再画圆点。
 *
 * 交互：按住任意位置拖动 = 滚动；悬停显示「● n / total 话题」卡片并暂停荡漾。
 * 约束：纯 UI 组件（无 IPC / 无 electron），不改变 Loopsoar 分层。
 */
import * as React from "react";
import { DEFAULT_CHAT_RAIL, loadRailParams, onRailParams, type RailParams } from "./railParams.js";

export interface TopicRailProps {
  scroller: () => HTMLElement | null;
  /** 当前上下文占用（0~1），无话题标签时显示在悬停卡片里 */
  contextRatio?: () => number;
}

interface RailPoint {
  y: number;
  label: string;
}

/** ——— slime 卷轴几何常量（与宿主右侧留白成对出现，改一处必须同步另一处）——— */
const LEFT_ROOM = 12;
const RIGHT_ROOM = 6;
/** 视口位置的内边距（slime 的 R.PAD） */
const PAD = 3;
/** 两端渐隐下限（slime 的 R.EFLOOR） */
const E_FLOOR = 0.12;
/** 悬停收拢窗口（slime 的 a / b） */
const HOVER_A = 4;
const HOVER_B = 6.8;
/** 鼓包宽度（slime 的 sig=13） */
const BUMP_SIGMA = 13;
/** 鼓包 / 回弹强度（slime 的 bulge=280%、dip=110%） */
const BULGE = 2.8;
const DIP = 1.1;
/** 回弹项宽度（slime 的 T=2.7） */
const DIP_T = 2.7;

export default function TopicRail({ scroller, contextRatio }: TopicRailProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  const tipOrdRef = React.useRef<HTMLSpanElement | null>(null);
  const tipTextRef = React.useRef<HTMLSpanElement | null>(null);
  const paramsRef = React.useRef<RailParams>(DEFAULT_CHAT_RAIL);
  const pointsRef = React.useRef<RailPoint[]>([]);
  const hoverRef = React.useRef(false);
  const dragRef = React.useRef(false);
  /** 指针目标高度（px，相对卷轴顶部）；-1 表示未进入 */
  const pointerYRef = React.useRef(-1);
  /** 平滑后的指针高度（slime 的 ptr.uc，鼓包跟随它缓动） */
  const pointerSmoothRef = React.useRef(0);
  /** 悬停强度 0~1（slime 的 ptr.strength） */
  const strengthRef = React.useRef(0);
  const reducedRef = React.useRef(false);

  React.useEffect(() => {
    const apply = (params: RailParams): void => {
      paramsRef.current = params;
      window.dispatchEvent(new CustomEvent("loopsoar:rail-repaint"));
    };
    apply(loadRailParams());
    return onRailParams(apply);
  }, []);

  React.useEffect(() => {
    reducedRef.current =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
          document.documentElement.dataset.animations === "off"
        : false;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const tipOrd = tipOrdRef.current;
    const tipText = tipTextRef.current;
    const el = scroller();
    if (!host || !canvas || !tip || !tipOrd || !tipText || !el) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;
    let dpr = 1;
    let height = 100;
    let lastT = 0;
    /** 荡漾累计时间（秒），驱动 driftPhase */
    let driftT = 0;
    let driftPhase = 0;
    let scrollPhase = 0;

    const collect = (): RailPoint[] => {
      const sc = scroller();
      if (!sc) return [];
      // 只取「话题锚点」（用户消息）；助手回复不再逐条打点（slime 的卷轴是连续的）。
      const nodes = Array.from(sc.querySelectorAll<HTMLElement>("[data-rail-label][data-rail-role='user']"));
      const base = sc.getBoundingClientRect().top - sc.scrollTop + sc.clientTop;
      return nodes.map((node) => ({
        y: Math.max(0, node.getBoundingClientRect().top - base),
        label: node.getAttribute("data-rail-label") || "",
      }));
    };

    const layout = (): void => {
      dpr = Math.min(3, window.devicePixelRatio || 1);
      const width = paramsRef.current.w;
      const totalW = LEFT_ROOM + width + RIGHT_ROOM;
      height = Math.max(20, host.clientHeight);
      canvas.width = Math.round(totalW * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${totalW}px`;
      canvas.style.height = `${height}px`;
      canvas.style.left = `-${LEFT_ROOM}px`;
      canvas.style.top = "0";
      canvas.style.position = "absolute";
      canvas.style.display = "block";
      canvas.style.pointerEvents = "none";
      // slime 的教训：contain:paint 只能放 canvas，不能放 host（否则把左伸的悬浮卡片裁掉）。
      canvas.style.setProperty("contain", "paint");
      host.style.width = `${width}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pointsRef.current = collect();
    };

    const paint = (): void => {
      const sc = scroller();
      if (!sc) return;
      const p = paramsRef.current;
      const W = p.w;
      const cw = LEFT_ROOM + W + RIGHT_ROOM;
      ctx.clearRect(0, 0, cw, height);
      if (height <= 8) return;

      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const ratio = Math.min(1, Math.max(0, sc.scrollTop / maxScroll));
      const innerH = height - PAD * 2;
      const puC = Math.min(height, Math.max(0, PAD + ratio * Math.max(1, innerH)));
      scrollPhase = sc.scrollTop * 0.0105;

      // 波形带宽：slime 的 band() 逐项照搬（右侧 88% 宽、左侧留 1.2px）
      const right = LEFT_ROOM + W * 0.88;
      const left = LEFT_ROOM + 1.2;
      const cx = (left + right) / 2;
      const maxAmp = Math.max(0.6, (right - left) / 2);
      const baseAmp = maxAmp * (p.amp / 100);
      const tap = Math.max(0, Math.min(p.tap, height * 0.4));
      const dir = p.flip ? -1 : 1;

      const taper = (u: number): number => {
        if (tap <= 0) return 1;
        const e = Math.min(u, height - u);
        const s = Math.min(1, Math.max(0, e / tap));
        return E_FLOOR + (1 - E_FLOOR) * (s * s * (3 - 2 * s));
      };

      const strength = strengthRef.current;
      const ptrU = pointerSmoothRef.current;

      /** slime 的 shapeAt：指针附近两股收拢 + 高斯鼓包/回弹（向外突起） */
      const shapeAt = (u: number): { sep: number; push: number; cx: number } => {
        const t = (u - ptrU) / BUMP_SIGMA;
        const at = Math.abs(t);
        const win =
          at <= HOVER_A ? 1 : at >= HOVER_B ? 0 : 0.5 * (1 + Math.cos((Math.PI * (at - HOVER_A)) / (HOVER_B - HOVER_A)));
        const wOsc = Math.min(1, strength * win);
        const bump = Math.exp(-(t * t) / 2);
        const dipTerm = ((t * t) / DIP_T) * Math.exp(1 - (t * t) / DIP_T);
        const h = BULGE * bump - (DIP + BULGE * Math.exp(-DIP_T / 2)) * dipTerm;
        let push = -dir * maxAmp * strength * h;
        const lo = 1.4 - cx;
        const hi = cw - 2.0 - cx;
        if (push < lo) push = lo;
        if (push > hi) push = hi;
        return { sep: baseAmp * (1 - wOsc) * taper(u), push, cx };
      };

      /** slime 的 lineStyle：视口位置之上更亮、之下更暗，两端再乘渐隐 */
      const lineStyle = (color: string, aLit: number, aDim: number, at: number): CanvasGradient => {
        const blend = Math.max(14, height * 0.07);
        const stops = [0, tap, at - blend, at + blend, height - tap, height].sort((x, y) => x - y);
        const g = ctx.createLinearGradient(0, 0, 0, height);
        const seen: Record<string, 1> = {};
        for (const sRaw of stops) {
          const y = Math.max(0, Math.min(height, sRaw));
          const key = y.toFixed(2);
          if (seen[key]) continue;
          seen[key] = 1;
          let a: number;
          if (y <= at - blend) a = aLit;
          else if (y >= at + blend) a = aDim;
          else a = aLit + (aDim - aLit) * ((y - (at - blend)) / (2 * blend));
          g.addColorStop(y / height, `rgba(${color},${Math.max(0, a * taper(y)).toFixed(3)})`);
        }
        return g;
      };

      const strokeWave = (lam: number, phi: number, width: number, style: CanvasGradient, key: number): void => {
        const N = Math.max(2, Math.ceil(height / 2));
        ctx.beginPath();
        for (let k = 0; k <= N; k++) {
          const u = (height * k) / N;
          const sh = shapeAt(u);
          const x = sh.cx + sh.push + sh.sep * key * Math.sin((Math.PI * 2 * u) / lam + phi + driftPhase + scrollPhase);
          if (k === 0) ctx.moveTo(x, u);
          else ctx.lineTo(x, u);
        }
        ctx.lineWidth = width;
        ctx.strokeStyle = style;
        ctx.lineCap = "round";
        ctx.stroke();
      };

      // 两股参数几何照搬 slime，颜色换成 Loopsoar 品牌色（亚麻白主股 + 赭石辅股），
      // 各自带一档宽光晕；alpha 比例沿用 slime，保证编织层次一致。
      const strands: Array<{
        lam: number;
        phi: number;
        key: number;
        w: number;
        cr: string;
        aLit: number;
        aDim: number;
        aGlow: number;
        gw: number;
      }> = [
        { lam: p.lam0, phi: 0, key: 1, w: W * 0.13, cr: "244,239,230", aLit: 0.95, aDim: 0.58, aGlow: 0.1, gw: 1.5 },
        { lam: p.lam1, phi: Math.PI, key: -1, w: W * 0.095, cr: "216,141,86", aLit: 0.55, aDim: 0.36, aGlow: 0.13, gw: 2.0 },
      ];
      for (const s of strands) {
        strokeWave(s.lam, s.phi, s.w, lineStyle(s.cr, s.aLit, s.aDim, puC), s.key);
        strokeWave(s.lam, s.phi, s.w * s.gw, lineStyle(s.cr, s.aGlow, s.aGlow, height), s.key);
      }
    };

    const frame = (t: number): void => {
      if (disposed) return;
      const p = paramsRef.current;
      const dt = lastT ? Math.min(48, t - lastT) : 16;
      lastT = t;
      const frozen = reducedRef.current || (p.pause && hoverRef.current) || dragRef.current || p.spd === 0;
      const speed = frozen ? 0 : p.spd;
      driftT += (dt / 1000) * speed;
      driftPhase = reducedRef.current ? 0 : (driftT * Math.PI * 2) / 5.2;

      // 悬停强度：进入约 150ms、离开自然收回（slime 的 0.18/帧）
      const want = hoverRef.current && pointerYRef.current >= 0 ? 1 : 0;
      const kStrong = 1 - Math.pow(1 - 0.18, dt / 16.7);
      strengthRef.current += (want - strengthRef.current) * kStrong;
      if (want === 1 && strengthRef.current > 0.998) strengthRef.current = 1;
      if (want === 0 && strengthRef.current < 0.002) strengthRef.current = 0;

      // 鼓包中心跟随指针（slime 的 damp=0.22/帧）
      if (pointerYRef.current >= 0) {
        const kDamp = 1 - Math.pow(1 - 0.22, dt / 16.7);
        pointerSmoothRef.current += (pointerYRef.current - pointerSmoothRef.current) * kDamp;
        if (Math.abs(pointerYRef.current - pointerSmoothRef.current) < 0.25) {
          pointerSmoothRef.current = pointerYRef.current;
        }
      }

      paint();
      raf = requestAnimationFrame(frame);
    };

    const jump = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const y = Math.min(height - 6, Math.max(6, clientY - rect.top));
      const f = (y - 6) / Math.max(1, height - 12);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTo({ top: f * maxScroll, behavior: "auto" });
    };

    const showTip = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const y = Math.min(height - 6, Math.max(6, clientY - rect.top));
      const f = (y - 6) / Math.max(1, height - 12);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const scrollTop = f * maxScroll;
      let nearest: RailPoint | null = null;
      let nearestIndex = -1;
      let best = Infinity;
      const points = pointsRef.current;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(points[i].y - scrollTop);
        if (d < best) {
          best = d;
          nearest = points[i];
          nearestIndex = i;
        }
      }
      const pct = Math.round(f * 100);
      // slime 的悬停卡片：左侧圆点 + 「n / total」序号 + 话题标签。
      tipOrd.textContent = nearestIndex >= 0 ? `${nearestIndex + 1} / ${points.length}` : `${pct}%`;
      tipText.textContent = nearest?.label
        ? nearest.label.slice(0, 80)
        : contextRatio
          ? `上下文 ${Math.round(contextRatio() * 100)}%`
          : "";
      // 跟随鼠标，只动 transform（合成器属性，不触发布局）。
      const half = 16;
      tip.style.transform = `translate3d(0, ${Math.min(height - half, Math.max(half, y)) - half}px, 0)`;
      tip.classList.add("on");
    };

    const onPointerDown = (event: PointerEvent): void => {
      event.preventDefault();
      dragRef.current = true;
      host.setPointerCapture?.(event.pointerId);
      jump(event.clientY);
      showTip(event.clientY);
    };
    const onPointerMove = (event: PointerEvent): void => {
      hoverRef.current = true;
      const y = Math.max(0, Math.min(height, event.clientY - host.getBoundingClientRect().top));
      pointerYRef.current = y;
      if (dragRef.current) jump(event.clientY);
      showTip(event.clientY);
      // 即使 rAF 被系统降频/暂停，指针移动时也立即重绘一次，避免「悬停没反应」。
      paint();
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragRef.current = false;
      host.releasePointerCapture?.(event.pointerId);
    };
    const onPointerEnter = (): void => {
      hoverRef.current = true;
    };
    const onPointerLeave = (): void => {
      hoverRef.current = false;
      // 保留 pointerYRef：强度从最后位置平滑收回，避免鼓包瞬间跳没。
      if (!dragRef.current) tip.classList.remove("on");
    };
    const onScroll = (): void => {
      pointsRef.current = collect();
      paint();
    };
    const onRepaint = (): void => {
      layout();
      paint();
    };

    layout();
    paint();
    if (!reducedRef.current) raf = requestAnimationFrame(frame);

    const resizeObserver = new ResizeObserver(() => {
      layout();
      paint();
    });
    resizeObserver.observe(host);
    const scrollerObserver = new ResizeObserver(() => {
      layout();
      paint();
    });
    scrollerObserver.observe(el);
    const onWinResize = (): void => {
      layout();
      paint();
    };
    window.addEventListener("resize", onWinResize);
    window.addEventListener("loopsoar:rail-repaint", onRepaint);
    el.addEventListener("scroll", onScroll, { passive: true });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointerenter", onPointerEnter);
    host.addEventListener("pointerleave", onPointerLeave);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      scrollerObserver.disconnect();
      window.removeEventListener("resize", onWinResize);
      window.removeEventListener("loopsoar:rail-repaint", onRepaint);
      el.removeEventListener("scroll", onScroll);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointerenter", onPointerEnter);
      host.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [scroller, contextRatio]);

  return (
    <div
      ref={hostRef}
      className="topic-rail"
      title="拖动卷轴滚动 · 悬停查看位置"
      style={{
        position: "absolute",
        top: 6,
        bottom: 6,
        right: 3,
        width: DEFAULT_CHAT_RAIL.w,
        cursor: "pointer",
        touchAction: "none",
        zIndex: 3,
      }}
    >
      <canvas ref={canvasRef} />
      <div ref={tipRef} className="topic-rail-tip">
        <i className="dot" />
        <span className="ord" ref={tipOrdRef} />
        <span className="txt" ref={tipTextRef} />
      </div>
    </div>
  );
}
