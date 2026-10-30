/**
 * TopicRail —— slime 卷轴（TopicRail）的 Loopsoar 移植版（按 slime 的「双线交织」画法重写）。
 *
 * 特征：
 *   · 两条不同波长的正弦线交织（亮线 lam0 / 暗线 lam1），振幅按参数调节；
 *   · 视口所在区段高亮 + 辉光 + 视口胶囊；拖动任意位置 = 拖动滚动（替代原生 scrollbar）；
 *   · 悬停显示「百分比 · 最近消息摘要」；消息锚点显示刻度；
 *   · 参数来自 railParams.ts（外观页可调，localStorage 持久化，事件即时生效）；
 *   · prefers-reduced-motion / html[data-animations=off] 下静止。
 *
 * 设计约束：纯 UI，无 IPC / 无 electron；不改变 Loopsoar 分层。
 */
import * as React from "react";
import { DEFAULT_CHAT_RAIL, loadRailParams, onRailParams, type RailParams } from "./railParams.js";

export interface TopicRailProps {
  scroller: () => HTMLElement | null;
  /** 当前上下文占用（0~1），显示在悬停提示里 */
  contextRatio?: () => number;
}

interface RailPoint {
  y: number;
  label: string;
}

export default function TopicRail({ scroller, contextRatio }: TopicRailProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  const tipTextRef = React.useRef<HTMLSpanElement | null>(null);
  const paramsRef = React.useRef<RailParams>(DEFAULT_CHAT_RAIL);
  const pointsRef = React.useRef<RailPoint[]>([]);
  const phaseRef = React.useRef(0);
  const hoverRef = React.useRef(false);
  const dragRef = React.useRef(false);
  const reducedRef = React.useRef(false);
  const [railWidth, setRailWidth] = React.useState<number>(DEFAULT_CHAT_RAIL.w);

  // 参数：加载 + 订阅外观页变更（即时生效，不重挂载）
  React.useEffect(() => {
    const apply = (params: RailParams): void => {
      paramsRef.current = params;
      setRailWidth(params.w);
      window.dispatchEvent(new CustomEvent("loopsoar:rail-repaint"));
    };
    apply(loadRailParams());
    const off = onRailParams(apply);
    return off;
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
    const tipText = tipTextRef.current;
    const el = scroller();
    if (!host || !canvas || !tip || !tipText || !el) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;
    let dpr = 1;
    let height = 100;

    const collect = (): RailPoint[] => {
      const sc = scroller();
      if (!sc) return [];
      const nodes = Array.from(sc.querySelectorAll<HTMLElement>("[data-rail-label]"));
      const base = sc.getBoundingClientRect().top - sc.scrollTop + sc.clientTop;
      return nodes.map((node) => ({
        y: Math.max(0, node.getBoundingClientRect().top - base),
        label: node.getAttribute("data-rail-label") || "",
      }));
    };

    const layout = (): void => {
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const width = paramsRef.current.w;
      height = Math.max(20, host.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      host.style.width = `${width}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pointsRef.current = collect();
    };

    const paint = (): void => {
      const sc = scroller();
      if (!sc) return;
      const p = paramsRef.current;
      const width = p.w;
      const pad = 10;
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const ratio = Math.min(1, Math.max(0, sc.scrollTop / maxScroll));
      const innerH = height - pad * 2;
      const vpCenter = pad + ratio * innerH;
      const vpLen = Math.max(20, (sc.clientHeight / Math.max(1, sc.scrollHeight)) * innerH);
      const cx = width / 2;
      const maxAmp = Math.max(1, width / 2 - 2);
      const baseAmp = (maxAmp * p.amp) / 100;
      const phase = phaseRef.current;
      const dir = p.flip ? -1 : 1;

      ctx.clearRect(0, 0, width, height);
      if (height <= 4) return;

      const taper = (y: number): number => {
        if (p.tap <= 0) return 1;
        const e = Math.min(y - pad, height - pad - y);
        const t = Math.min(1, Math.max(0, e / p.tap));
        return 0.12 + 0.88 * (t * t * (3 - 2 * t));
      };

      // 视口附近的「隆起/凹陷」衬托（slime 的 bulge/dip 简化版）
      const pushAt = (y: number): number => {
        const d = (y - vpCenter) / (vpLen * 0.9 + 1);
        const bump = Math.exp(-(d * d) / 2);
        return dir * baseAmp * 0.9 * bump;
      };

      const lineX = (y: number, lambda: number, phi: number): number => {
        const amp = baseAmp * taper(y);
        return cx + pushAt(y) + amp * Math.sin((Math.PI * 2 * y) / Math.max(4, lambda) + phase + phi);
      };

      const strokeWave = (
        lambda: number,
        phi: number,
        widthPx: number,
        stroke: string | CanvasGradient,
        blur: number,
        from: number,
        to: number,
      ): void => {
        ctx.beginPath();
        for (let y = from; y <= to; y += 1.5) {
          const x = lineX(y, lambda, phi);
          if (y === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = widthPx;
        ctx.lineCap = "round";
        ctx.strokeStyle = stroke;
        ctx.shadowBlur = blur;
        ctx.shadowColor = "rgba(242,180,120,0.55)";
        ctx.stroke();
        ctx.shadowBlur = 0;
      };

      const top = pad;
      const bottom = height - pad;

      // 暗线（完整，波长 lam1）
      const dim = ctx.createLinearGradient(0, top, 0, bottom);
      dim.addColorStop(0, "rgba(200,118,60,0.14)");
      dim.addColorStop(0.5, "rgba(200,118,60,0.38)");
      dim.addColorStop(1, "rgba(200,118,60,0.14)");
      strokeWave(p.lam1, Math.PI / 2, 1.1, dim, 0, top, bottom);

      // 亮线（完整，波长 lam0，与暗线交织）
      const bright = ctx.createLinearGradient(0, top, 0, bottom);
      bright.addColorStop(0, "rgba(217,138,79,0.20)");
      bright.addColorStop(0.5, "rgba(242,180,120,0.60)");
      bright.addColorStop(1, "rgba(217,138,79,0.20)");
      strokeWave(p.lam0, 0, 1.5, bright, 0, top, bottom);

      // 视口高亮段（提亮 + 光晕）
      const litFrom = Math.max(top, vpCenter - vpLen / 2);
      const litTo = Math.min(bottom, vpCenter + vpLen / 2);
      const lit = ctx.createLinearGradient(0, litFrom, 0, litTo);
      lit.addColorStop(0, "rgba(217,138,79,0.25)");
      lit.addColorStop(0.5, "#ffd9b0");
      lit.addColorStop(1, "rgba(217,138,79,0.25)");
      strokeWave(p.lam0, 0, 2.2, lit, 10, litFrom, litTo);

      // 视口胶囊（拖动指示）
      ctx.beginPath();
      ctx.fillStyle = "rgba(217,138,79,0.20)";
      ctx.roundRect(cx - 6, vpCenter - vpLen / 2, 12, vpLen, 6);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,214,170,0.95)";
      ctx.roundRect(cx - 1.8, vpCenter - vpLen / 2 + 2, 3.6, Math.max(8, vpLen - 4), 2);
      ctx.fill();

      // 消息刻度
      for (const point of pointsRef.current) {
        const y = pad + (point.y / Math.max(1, sc.scrollHeight)) * innerH;
        if (y < top || y > bottom) continue;
        ctx.beginPath();
        ctx.fillStyle = "rgba(242,180,120,0.8)";
        ctx.arc(cx + width / 2 - 2.5, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = (t: number): void => {
      if (disposed) return;
      const p = paramsRef.current;
      const frozen = reducedRef.current || (p.pause && hoverRef.current) || dragRef.current || p.spd === 0;
      if (!frozen) phaseRef.current = t * 0.0016 * p.spd;
      paint();
      raf = requestAnimationFrame(frame);
    };

    const jump = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const pad = 10;
      const y = Math.min(height - pad, Math.max(pad, clientY - rect.top));
      const f = (y - pad) / Math.max(1, height - pad * 2);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTo({ top: f * maxScroll, behavior: "auto" });
    };

    const showTip = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const pad = 10;
      const rect = host.getBoundingClientRect();
      const y = Math.min(height - pad, Math.max(pad, clientY - rect.top));
      const f = (y - pad) / Math.max(1, height - pad * 2);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const scrollTop = f * maxScroll;
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
      tipText.textContent = `${pct}%${nearest?.label ? ` · ${nearest.label.slice(0, 24)}` : ""}${ctxPct !== null ? ` · 上下文 ${ctxPct}%` : ""}`;
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
      hoverRef.current = true;
      if (dragRef.current) jump(event.clientY);
      showTip(event.clientY);
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
    resizeObserver.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointerenter", onPointerEnter);
    host.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("loopsoar:rail-repaint", onRepaint);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      el.removeEventListener("scroll", onScroll);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointerenter", onPointerEnter);
      host.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("loopsoar:rail-repaint", onRepaint);
    };
  }, [scroller, contextRatio, railWidth]);

  return (
    <div
      ref={hostRef}
      className="topic-rail"
      title="拖动卷轴滚动 · 悬停查看位置"
      style={{ position: "absolute", top: 8, bottom: 8, right: 2, width: railWidth, cursor: "pointer", touchAction: "none", zIndex: 3 }}
    >
      <canvas ref={canvasRef} style={{ display: "block", pointerEvents: "none" }} />
      <div ref={tipRef} className="topic-rail-tip">
        <span ref={tipTextRef} />
      </div>
    </div>
  );
}
