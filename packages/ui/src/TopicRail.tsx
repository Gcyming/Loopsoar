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
  const tipOrdRef = React.useRef<HTMLSpanElement | null>(null);
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
      const amp = Math.max(2.2, Math.min(width / 2 - 2, (width / 2 - 2) * (p.amp / 100) * 1.9));
      const phase = phaseRef.current;
      // 滚动时波形随内容流动（slime 的 scrollPhase）：拖动/滚轮时线条不是死的。
      const scrollPhase = sc.scrollTop * 0.0105;
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
        return dir * amp * 0.4 * Math.exp(-(d * d) / 2);
      };
      // 指针附近把麻花辫「捏拢」并推开一点（slime 的 wOsc + push，不画光点）
      const ptrY = pointerYRef.current;
      const hovering = hoverRef.current && ptrY >= 0;
      const focusAt = (y: number): number => (hovering ? Math.exp(-(((y - ptrY) / 46) ** 2) / 2) : 0);
      const pointerPush = (y: number): number => dir * amp * 0.8 * focusAt(y);
      // 两股线反相、反向、不同波长 → 编织成麻花辫（slime 的 key + phi=π）
      const xAt = (y: number, lambda: number, phi: number, key: number): number => {
        const sep = amp * taper(y) * (1 - 0.55 * focusAt(y));
        const raw =
          cx +
          pushAt(y) +
          pointerPush(y) +
          sep * key * Math.sin((Math.PI * 2 * y) / Math.max(8, lambda) + phase + scrollPhase + phi);
        // 线的摆幅接近轨道宽度时容易被画布裁掉，这里留 1.2px 安全边。
        return Math.max(1.2, Math.min(width - 1.2, raw));
      };

      // 沿纵向渐变：视口中心最亮、上下渐暗、两端再乘 taper 渐隐（slime 的 lineStyle）
      const lineStyle = (rgb: string, aLit: number, aDim: number): CanvasGradient => {
        const blend = Math.max(14, height * 0.07);
        const stopYs = [0, p.tap, vpCenter - blend, vpCenter + blend, height - p.tap, height]
          .map((v) => Math.min(height, Math.max(0, v)))
          .sort((a, b) => a - b);
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        let last = -1;
        for (const y of stopYs) {
          if (Math.abs(y - last) < 0.5) continue;
          last = y;
          const a =
            y <= vpCenter - blend
              ? aLit
              : y >= vpCenter + blend
                ? aDim
                : aLit + (aDim - aLit) * ((y - (vpCenter - blend)) / (2 * blend));
          gradient.addColorStop(y / height, `rgba(${rgb},${Math.max(0, a * taper(y)).toFixed(3)})`);
        }
        return gradient;
      };

      // 单股：按 xAt 采样成一条竖向曲线（step=2，画布高度有限，足够顺滑且省 CPU）
      const wave = (lambda: number, phi: number, key: number, lineWidth: number, style: CanvasGradient): void => {
        ctx.beginPath();
        for (let y = 0; y <= height; y += 2) {
          const x = xAt(y, lambda, phi, key);
          if (y === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.strokeStyle = style;
        ctx.stroke();
      };

      // ① 亮股：linen 白，宽 → slime 的浅色主股
      wave(p.lam0, 0, 1, Math.max(1.8, width * 0.17), lineStyle("244,239,230", 0.96, 0.58));
      // ② 亮股光晕（同股更宽的半透明描边 = slime 的 glow pass）
      wave(p.lam0, 0, 1, Math.max(3.2, width * 0.34), lineStyle("244,239,230", 0.16, 0.10));
      // ③ 暗股：赭石，窄、反相、反向 → 与亮股编成麻花
      wave(p.lam1, Math.PI, -1, Math.max(1.4, width * 0.11), lineStyle("216,142,88", 0.85, 0.50));
      // ④ 暗股光晕
      wave(p.lam1, Math.PI, -1, Math.max(2.6, width * 0.26), lineStyle("216,142,88", 0.22, 0.14));
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
      // slime 的悬停卡片：左侧圆点 + 「n / total」序号 + 话题标签（不再挤一行百分比）。
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
        <i className="dot" />
        <span className="ord" ref={tipOrdRef} />
        <span className="txt" ref={tipTextRef} />
      </div>
    </div>
  );
}
