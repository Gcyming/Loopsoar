/**
 * TopicRail —— slime 卷轴（TopicRail）的 Loopsoar 移植版。
 *
 * 视觉目标（对齐 slime 实拍）：**极细、连绵的双股波浪线**贯穿整条高度，
 * 没有粗胶囊/滚动块；视口所在的一段只做「提亮 + 微光晕」，消息锚点是轨道右侧的小圆点。
 *
 * 悬停反馈（slime 的「突起」）：指针所在高度把线向左（聊天区一侧）鼓出一个平滑的包，
 * 强度逐帧缓动、离开时自然收回；画布向左侧多留 BUMP_PAD 空间，避免突起被裁切。
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
  /** 悬停突起强度 0~1：每帧向目标值缓动，指针离开时平滑收回。 */
  const bumpRef = React.useRef(0);
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

    /** 画布向轨道左侧多让出的空间：悬停时波形要向左鼓出，需要额外画布，否则会被裁掉。 */
    const BUMP_PAD = 30;

    const layout = (): void => {
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const width = paramsRef.current.w;
      const totalW = width + BUMP_PAD;
      height = Math.max(20, host.clientHeight);
      canvas.width = Math.round(totalW * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${totalW}px`;
      canvas.style.height = `${height}px`;
      canvas.style.marginLeft = `-${BUMP_PAD}px`;
      canvas.style.position = "relative";
      host.style.width = `${width}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pointsRef.current = collect();
    };

    const paint = (): void => {
      const sc = scroller();
      if (!sc) return;
      const p = paramsRef.current;
      const width = p.w;
      // 基线向左让 4px：突起两翼的 dip 会向聊天区反方向（右侧）回弹约 3~4px，
      // 原基线离窗口右缘只剩 ~11px，叠加 12px 光晕后会贴边裁切（用户反馈「右边凹陷在屏幕外」）。
      // 这里同时配合 index.html 的右侧光晕收紧，保证 dip + 光晕都留在窗口内。
      const cx = BUMP_PAD + width / 2 - 4;
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

      ctx.clearRect(0, 0, width + BUMP_PAD, height);
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
      // slime 的「突起」：指针所在高度把线向左（聊天区一侧）鼓出一个**局部**的包，
      // 强度由 bumpRef 每帧缓动，离开时自然收回。
      // 关键：高斯宽度必须是固定值，不能按轨道高度百分比缩放 ——
      // 否则窗口越高包越长，整条线会被拉成缓慢的 S 形大弯（用户反馈「又崩了」）。
      // 突起宽度/幅度可由用户在外观设置里调整（ADR-0032，railParams.bumpSigma / bumpReach）。
      // 默认 13px 高斯 + 13px 峰值：比上一版（16px/11.2px）更紧凑、更显眼，
      // 同时 dip 收得更近（DIP_T 2.7→2.2、DIP 1.1→0.75），不会向右侧甩太远。
      const bumpSigma = Math.max(8, p.bumpSigma);
      const bumpReach = Math.max(0, p.bumpReach);
      const ptrY = pointerYRef.current;
      const hovering = hoverRef.current && ptrY >= 0;
      const bumpAmt = bumpRef.current;
      // 突起形状沿用 slime 的 bulge + dip：中心高斯向外鼓，两翼轻微回缩，
      // 这样线与线的过渡是圆的、没有折角（纯高斯在窄线上会显得像「肘部」）。
      const BULGE = 2.8;
      const DIP = 0.75;
      const DIP_T = 2.2;
      const pointerPush = (y: number): number => {
        if (bumpAmt <= 0.001 || ptrY < 0) return 0;
        const t = (y - ptrY) / bumpSigma;
        const bump = Math.exp(-(t * t) / 2);
        const dipTerm = ((t * t) / DIP_T) * Math.exp(1 - (t * t) / DIP_T);
        const h = BULGE * bump - (DIP + BULGE * Math.exp(-DIP_T / 2)) * dipTerm;
        return (-bumpAmt * bumpReach * h) / BULGE;
      };
      // 突起区内压平基础荡漾：两股线（λ0/λ1 相位不同）在平移中心附近会交叉成 S 形/打结，
      // 把正弦项乘以 1-0.85*bumpAmt*高斯，指针处两股重合为一条平滑外鼓曲线，离开后逐渐恢复波纹。
      const waveDamp = (y: number): number => {
        if (bumpAmt <= 0.001 || ptrY < 0) return 1;
        const d = (y - ptrY) / (bumpSigma * 1.15);
        return 1 - 0.85 * bumpAmt * Math.exp(-(d * d) / 2);
      };
      const xAt = (y: number, lambda: number, phi: number): number =>
        cx +
        pushAt(y) +
        pointerPush(y) +
        amp * taper(y) * waveDamp(y) * Math.sin((Math.PI * 2 * y) / Math.max(8, lambda) + phase + phi);

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
      const dotX = BUMP_PAD + width - 4.5;
      for (const point of pointsRef.current) {
        const y = padTop + (point.y / Math.max(1, sc.scrollHeight)) * innerH;
        if (y < top - 2 || y > bottom + 2) continue;
        ctx.beginPath();
        ctx.fillStyle = hoverRef.current ? "rgba(255, 214, 170, 0.95)" : "rgba(245, 190, 140, 0.7)";
        ctx.arc(dotX, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }

      // ⑤ 悬停：指针附近的一小段线被提亮（衬托 + 局部高光），不画光点
      if (hovering) {
        const from = Math.max(top, ptrY - bumpSigma * 2.4);
        const to = Math.min(bottom, ptrY + bumpSigma * 2.4);
        const hoverGrad = ctx.createLinearGradient(0, from, 0, to);
        hoverGrad.addColorStop(0, "rgba(255, 224, 190, 0.10)");
        hoverGrad.addColorStop(0.5, "rgba(255, 236, 214, 1)");
        hoverGrad.addColorStop(1, "rgba(255, 224, 190, 0.10)");
        ctx.beginPath();
        for (let y = from; y <= to; y += 1) {
          const x = xAt(y, p.lam0, 0);
          if (y === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.strokeStyle = hoverGrad;
        // 光晕从 12 收到 8：原光晕在窗口右缘会被裁切，视觉上像「凹陷钻出屏幕」。
        ctx.shadowBlur = 8;
        ctx.shadowColor = "rgba(255, 214, 170, 0.75)";
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    };

    const frame = (t: number): void => {
      if (disposed) return;
      const p = paramsRef.current;
      const frozen = reducedRef.current || (p.pause && hoverRef.current) || dragRef.current || p.spd === 0;
      if (!frozen) phaseRef.current = t * 0.0009 * p.spd;
      // 悬停突起：向目标缓动（进入约 150ms、离开自然收回），不受荡漾暂停影响。
      const bumpTarget = hoverRef.current && pointerYRef.current >= 0 ? 1 : 0;
      bumpRef.current += (bumpTarget - bumpRef.current) * 0.16;
      if (Math.abs(bumpTarget - bumpRef.current) < 0.003) bumpRef.current = bumpTarget;
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
      // 指针移动后立即重绘：即使 rAF 被系统降频/暂停，突起也不会看起来「没反应」。
      if (reducedRef.current) bumpRef.current = 1;
      paint();
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragRef.current = false;
      host.releasePointerCapture?.(event.pointerId);
    };
    const onPointerEnter = (event: PointerEvent): void => {
      hoverRef.current = true;
      // 进入的第一帧就把突起定位到当前指针：不能沿用上一次离开时保存的位置，
      // 否则下一次悬停会看到「突起从旧位置滑到新位置」的假动画。
      pointerYRef.current = Math.max(0, Math.min(height, event.clientY - host.getBoundingClientRect().top));
      if (reducedRef.current) {
        bumpRef.current = pointerYRef.current >= 0 ? 1 : 0;
        paint();
      }
    };
    const onPointerLeave = (): void => {
      hoverRef.current = false;
      // 保留 pointerYRef 让突起从最后一次位置平滑收回；tip 立即隐藏即可。
      if (reducedRef.current) {
        bumpRef.current = 0;
        paint();
      }
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
      style={{ position: "absolute", top: 6, bottom: 6, right: 4, width: railWidth, cursor: "pointer", touchAction: "none", zIndex: 3 }}
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
