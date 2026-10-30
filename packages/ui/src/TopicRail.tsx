/**
 * TopicRail —— slime 卷轴（TopicRail）的 Loopsoar 移植版。
 *
 * 作用：替换聊天区原生滚动条。右侧竖直画布上绘制一条「波浪卷轴」：
 *   · 波浪线全程可见（暗），当前视口所在区段高亮；
 *   · 拖动卷轴 = 拖动滚动位置（替代原生 scrollbar 拖拽）；
 *   · 悬停显示当前位置百分比 + 最近消息摘要；点击跳转；
 *   · 消息锚点（[data-rail-label]）在卷轴上显示小刻度。
 *
 * 设计约束（保持 Loopsoar 框架）：纯 UI 组件，无 electron/无 IPC；受 html[data-animations] 控制。
 */
import * as React from "react";

export interface TopicRailProps {
  scroller: () => HTMLElement | null;
  /** 当前上下文占用（0~1），显示在悬停提示里 */
  contextRatio?: () => number;
}

interface RailPoint {
  y: number;
  label: string;
}

const RAIL_WIDTH = 20;
const PAD = 10;

export default function TopicRail({ scroller, contextRatio }: TopicRailProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  const tipTextRef = React.useRef<HTMLSpanElement | null>(null);
  const dragRef = React.useRef(false);
  const pointsRef = React.useRef<RailPoint[]>([]);
  const phaseRef = React.useRef(0);
  const reducedRef = React.useRef(false);

  React.useEffect(() => {
    reducedRef.current =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const tipText = tipTextRef.current;
    const el = scroller();
    if (!host || !canvas || !tip || !tipText || !el) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;
    let dpr = 1;
    let width = RAIL_WIDTH;
    let height = 100;

    const collect = (): RailPoint[] => {
      const sc = scroller();
      if (!sc) return [];
      const nodes = Array.from(sc.querySelectorAll<HTMLElement>("[data-rail-label]"));
      const base = sc.getBoundingClientRect().top - sc.scrollTop + sc.clientTop;
      const points: RailPoint[] = [];
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const top = rect.top - base;
        points.push({ y: Math.max(0, top), label: node.getAttribute("data-rail-label") || "" });
      }
      return points;
    };

    const layout = (): void => {
      const sc = scroller();
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      width = RAIL_WIDTH;
      height = Math.max(20, host.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pointsRef.current = sc ? collect() : [];
    };

    const paint = (): void => {
      const sc = scroller();
      if (!sc) return;
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const ratio = Math.min(1, Math.max(0, sc.scrollTop / maxScroll));
      const innerH = height - PAD * 2;
      const vpCenter = PAD + ratio * innerH;
      // 视口区段在卷轴上的高度（最小 18px）
      const vpLen = Math.max(18, (sc.clientHeight / Math.max(1, sc.scrollHeight)) * innerH);
      const top = PAD;
      const bottom = height - PAD;
      const cx = width / 2;
      const phase = phaseRef.current;
      const amp = 3.4;

      ctx.clearRect(0, 0, width, height);

      // 波浪路径（视口附近振幅更明显，远处收敛成细线）
      const pathAt = (yy: number): number => {
        const d = Math.abs(yy - vpCenter) / (vpLen / 2 + 1);
        const env = 0.35 + 0.65 * Math.exp(-d * d);
        return cx + Math.sin(yy / 13 + phase) * amp * env;
      };

      const strokeWave = (from: number, to: number, lineWidth: number, stroke: string | CanvasGradient, blur = 0): void => {
        ctx.beginPath();
        for (let y = from; y <= to; y += 2) {
          const x = pathAt(y);
          if (y === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = stroke;
        ctx.lineCap = "round";
        ctx.shadowBlur = blur;
        ctx.shadowColor = "rgba(217,138,79,0.55)";
        ctx.stroke();
        ctx.shadowBlur = 0;
      };

      // 暗线（全程）
      const dim = ctx.createLinearGradient(0, top, 0, bottom);
      dim.addColorStop(0, "rgba(200,118,60,0.18)");
      dim.addColorStop(0.5, "rgba(200,118,60,0.45)");
      dim.addColorStop(1, "rgba(200,118,60,0.18)");
      strokeWave(top, bottom, 1.1, dim);

      // 亮线（视口区段 + 光晕）
      const litFrom = Math.max(top, vpCenter - vpLen / 2);
      const litTo = Math.min(bottom, vpCenter + vpLen / 2);
      const lit = ctx.createLinearGradient(0, litFrom, 0, litTo);
      lit.addColorStop(0, "rgba(217,138,79,0.20)");
      lit.addColorStop(0.5, "rgba(255,214,170,1)");
      lit.addColorStop(1, "rgba(217,138,79,0.20)");
      strokeWave(litFrom, litTo, 2.1, lit, 9);

      // 视口指示胶囊
      ctx.beginPath();
      ctx.fillStyle = "rgba(217,138,79,0.22)";
      ctx.roundRect(cx - 5, vpCenter - vpLen / 2, 10, vpLen, 5);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,214,170,0.95)";
      ctx.roundRect(cx - 1.6, vpCenter - vpLen / 2 + 2, 3.2, Math.max(6, vpLen - 4), 2);
      ctx.fill();

      // 消息刻度
      for (const point of pointsRef.current) {
        const y = PAD + (point.y / Math.max(1, sc.scrollHeight)) * innerH;
        if (y < top || y > bottom) continue;
        ctx.beginPath();
        ctx.fillStyle = "rgba(242,180,120,0.75)";
        ctx.arc(cx + 7, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = (t: number): void => {
      if (disposed) return;
      if (!reducedRef.current) phaseRef.current = t * 0.0016;
      paint();
      raf = requestAnimationFrame(frame);
    };

    const jump = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const y = Math.min(height - PAD, Math.max(PAD, clientY - rect.top));
      const f = (y - PAD) / Math.max(1, height - PAD * 2);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTo({ top: f * maxScroll, behavior: reducedRef.current ? "auto" : "smooth" });
    };

    const showTip = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const y = Math.min(height - PAD, Math.max(PAD, clientY - rect.top));
      const f = (y - PAD) / Math.max(1, height - PAD * 2);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const scrollTop = f * maxScroll;
      // 最近消息
      let nearest: RailPoint | null = null;
      let best = Infinity;
      for (const point of pointsRef.current) {
        const d = Math.abs(point.y - scrollTop);
        if (d < best) {
          best = d;
          nearest = point;
        }
      }
      const pct = Math.round(f * 100);
      const ctxPct = contextRatio ? Math.round(contextRatio() * 100) : null;
      tipText.textContent = `${pct}%${nearest?.label ? ` · ${nearest.label.slice(0, 22)}` : ""}${ctxPct !== null ? ` · 上下文 ${ctxPct}%` : ""}`;
      tip.style.transform = `translateY(${Math.min(height - 30, Math.max(4, y - 12))}px)`;
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
      if (dragRef.current) jump(event.clientY);
      showTip(event.clientY);
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragRef.current = false;
      host.releasePointerCapture?.(event.pointerId);
    };
    const onPointerLeave = (): void => {
      if (!dragRef.current) tip.classList.remove("on");
    };
    const onScroll = (): void => {
      pointsRef.current = collect();
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
    resizeObserver.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointerleave", onPointerLeave);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      el.removeEventListener("scroll", onScroll);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [scroller, contextRatio]);

  return (
    <div ref={hostRef} className="topic-rail" style={{ position: "absolute", top: 8, bottom: 8, right: 2, width: RAIL_WIDTH, cursor: "pointer", touchAction: "none", zIndex: 3 }}>
      <canvas ref={canvasRef} style={{ display: "block", pointerEvents: "none" }} />
      <div ref={tipRef} className="topic-rail-tip">
        <span ref={tipTextRef} />
      </div>
    </div>
  );
}
