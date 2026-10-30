/**
 * TopicRail —— slime 卷轴（TopicRail）的 Loopsoar 移植版。
 *
 * 视觉目标（对齐 slime 实拍）：**极细、连绵的双股波浪线**贯穿整条高度，
 * 没有粗胶囊/滚动块；视口所在的一段只做「提亮 + 微光晕」，消息锚点是轨道右侧的小圆点。
 *
 * 交互：按住任意位置拖动 = 滚动；悬停显示位置气泡并暂停荡漾；方向键可微调。
 * 参数：railParams.ts（外观页可调、localStorage 持久化、事件即时生效）。
 * 约束：纯 UI 组件（无 IPC / 无 electron），不改变 Loopsoar 分层。
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
  const pointerYRef = React.useRef(-1);
  const reducedRef = React.useRef(false);
  const [railWidth, setRailWidth] = React.useState<number>(DEFAULT_CHAT_RAIL.w);

  React.useEffect(() => {
    const apply = (params: RailParams): void => {
      paramsRef.current = params;
      setRailWidth(params.w);
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
      // 只取「话题锚点」（用户消息）；助手回复不再逐条打点（slime 的卷轴刻度是稀疏的）
      const nodes = Array.from(sc.querySelectorAll<HTMLElement>("[data-rail-label][data-rail-role='user']"));
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
      const cx = width / 2;
      const padTop = 6;
      const padBottom = 6;
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const ratio = Math.min(1, Math.max(0, sc.scrollTop / maxScroll));
      const innerH = height - padTop - padBottom;
      const vpCenter = padTop + ratio * innerH;
      const vpLen = Math.max(26, (sc.clientHeight / Math.max(1, sc.scrollHeight)) * innerH);
      const amp = Math.max(0.8, (width / 2 - 4) * (p.amp / 100));
      const phase = phaseRef.current;
      const dir = p.flip ? -1 : 1;

      ctx.clearRect(0, 0, width, height);
      if (height <= 8) return;

      // 两端渐隐
      const taper = (y: number): number => {
        if (p.tap <= 0) return 1;
        const e = Math.min(y - padTop, height - padBottom - y);
        const t = Math.min(1, Math.max(0, e / p.tap));
        return 0.15 + 0.85 * (t * t * (3 - 2 * t));
      };
      // 视口附近的轻微侧移（slime 的「衬托」）：不要大动作，只要看得出"当前段"
      const pushAt = (y: number): number => {
        const d = (y - vpCenter) / (vpLen * 1.1 + 1);
        return dir * amp * 0.7 * Math.exp(-(d * d) / 2);
      };
      const xAt = (y: number, lambda: number, phi: number): number =>
        cx + pushAt(y) + amp * taper(y) * Math.sin((Math.PI * 2 * y) / Math.max(8, lambda) + phase + phi);

      const stroke = (
        lambda: number,
        phi: number,
        from: number,
        to: number,
        lineWidth: number,
        color: string,
        blur: number,
      ): void => {
        ctx.beginPath();
        for (let y = from; y <= to; y += 1) {
          const x = xAt(y, lambda, phi);
          if (y === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.strokeStyle = color;
        if (blur > 0) {
          ctx.shadowBlur = blur;
          ctx.shadowColor = "rgba(255, 205, 160, 0.85)";
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      };

      const top = padTop;
      const bottom = height - padBottom;

      // ① 暗线（完整、细、低透明度）
      stroke(p.lam1, Math.PI / 2, top, bottom, 1, "rgba(200, 128, 74, 0.30)", 0);
      // ② 亮线（完整、稍亮）
      stroke(p.lam0, 0, top, bottom, 1.25, "rgba(245, 190, 140, 0.55)", 0);

      // ③ 视口段：两股线一起提亮 + 光晕（没有滚动块，只有"这一段在发光"）
      const litFrom = Math.max(top, vpCenter - vpLen / 2);
      const litTo = Math.min(bottom, vpCenter + vpLen / 2);
      const litGrad = ctx.createLinearGradient(0, litFrom, 0, litTo);
      litGrad.addColorStop(0, "rgba(255, 214, 170, 0.10)");
      litGrad.addColorStop(0.5, "rgba(255, 232, 205, 0.98)");
      litGrad.addColorStop(1, "rgba(255, 214, 170, 0.10)");
      ctx.shadowBlur = 0;
      // 用渐变作为 strokeStyle（渐变是竖直的，正好形成"中间亮两头暗"）
      ctx.beginPath();
      for (let y = litFrom; y <= litTo; y += 1) {
        const x = xAt(y, p.lam0, 0);
        if (y === litFrom) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 1.9;
      ctx.lineCap = "round";
      ctx.strokeStyle = litGrad;
      ctx.shadowBlur = 6;
      ctx.shadowColor = "rgba(255, 205, 160, 0.55)";
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ④ 话题锚点：轨道右侧的小圆点（稀疏，仅用户消息）
      const dotX = width - 4.5;
      for (const point of pointsRef.current) {
        const y = padTop + (point.y / Math.max(1, sc.scrollHeight)) * innerH;
        if (y < top - 2 || y > bottom + 2) continue;
        ctx.beginPath();
        ctx.fillStyle = hoverRef.current ? "rgba(255, 214, 170, 0.95)" : "rgba(245, 190, 140, 0.7)";
        ctx.arc(dotX, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }

      // ⑤ 悬停反馈：整条卷轴加一层很淡的暖色衬底 + 光标位置的光点
      if (hoverRef.current) {
        ctx.fillStyle = "rgba(217, 138, 79, 0.06)";
        ctx.fillRect(0, 0, width, height);
        if (pointerYRef.current >= 0) {
          ctx.beginPath();
          ctx.fillStyle = "rgba(255, 214, 170, 0.9)";
          ctx.shadowBlur = 8;
          ctx.shadowColor = "rgba(255, 205, 160, 0.8)";
          ctx.arc(cx, pointerYRef.current, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    };

    const frame = (t: number): void => {
      if (disposed) return;
      const p = paramsRef.current;
      const frozen = reducedRef.current || (p.pause && hoverRef.current) || dragRef.current || p.spd === 0;
      if (!frozen) phaseRef.current = t * 0.0009 * p.spd;
      paint();
      raf = requestAnimationFrame(frame);
    };

    const jump = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const padTop = 6;
      const y = Math.min(height - 6, Math.max(padTop, clientY - rect.top));
      const f = (y - padTop) / Math.max(1, height - padTop - 6);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTo({ top: f * maxScroll, behavior: "auto" });
    };

    const showTip = (clientY: number): void => {
      const sc = scroller();
      if (!sc) return;
      const rect = host.getBoundingClientRect();
      const padTop = 6;
      const y = Math.min(height - 6, Math.max(padTop, clientY - rect.top));
      const f = (y - padTop) / Math.max(1, height - padTop - 6);
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
      pointerYRef.current = Math.max(0, Math.min(height, event.clientY - host.getBoundingClientRect().top));
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
      pointerYRef.current = -1;
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
      style={{ position: "absolute", top: 6, bottom: 6, right: 3, width: railWidth, cursor: "pointer", touchAction: "none", zIndex: 3 }}
    >
      <canvas ref={canvasRef} style={{ display: "block", pointerEvents: "none" }} />
      <div ref={tipRef} className="topic-rail-tip">
        <span ref={tipTextRef} />
      </div>
    </div>
  );
}
