/**
 * 记忆图谱（E-M0）：Canvas 2D 环带渲染，零第三方依赖。
 *
 * 数据由壳层派生并算好 1000×1000 坐标（memory:graph），这里只做缩放、绘制与命中测试：
 *  - 原点在中心，会话在第一圈，事实挂在会话扇区内，无会话的事实落到外圈（游离）；
 *  - 半径/亮度由激活值决定，颜色由节点类型决定；
 *  - hover 高亮邻居，点击回调节点（由外层面板展示详情）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import type {
  MemoryGraphNodeView,
  MemoryGraphPointView,
  MemoryGraphResult,
} from "./types.js";

export interface MemoryGraphViewProps {
  data: MemoryGraphResult | null;
  height?: number;
  onSelect?: (node: MemoryGraphNodeView | null) => void;
}

const CANVAS_UNITS = 1000;
const COLORS = {
  origin: "#c8763c",
  session: "#5b8def",
  fact: "#9aa4b2",
  drift: "#5eead4",
  edge: "#8a8f98",
};

function colorOf(node: MemoryGraphNodeView | undefined): string {
  if (!node) return COLORS.fact;
  if (node.kind === "origin") return COLORS.origin;
  if (node.kind === "session") return COLORS.session;
  return node.band === "L1" ? COLORS.fact : COLORS.drift;
}

function alphaOf(node: MemoryGraphNodeView): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, node.activation));
}

export default function MemoryGraphView({ data, height = 380, onSelect }: MemoryGraphViewProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [width, setWidth] = React.useState(720);
  /** E-M2：激活值上升的节点脉冲 700ms；用 rAF 驱动重绘，动画结束即停。 */
  const pulsesRef = React.useRef(new Map<string, number>());
  const prevActivationRef = React.useRef(new Map<string, number>());
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!data) return;
    const now = performance.now();
    const prev = prevActivationRef.current;
    const next = new Map<string, number>();
    let started = false;
    for (const node of data.nodes) {
      next.set(node.id, node.activation);
      const before = prev.get(node.id);
      if (before !== undefined && node.activation - before > 0.02) {
        pulsesRef.current.set(node.id, now);
        started = true;
      }
    }
    prevActivationRef.current = next;
    if (!started) return;
    let raf = 0;
    const loop = (): void => {
      const t = performance.now();
      for (const [id, at] of pulsesRef.current) {
        if (t - at > 750) pulsesRef.current.delete(id);
      }
      setTick((value) => value + 1);
      if (pulsesRef.current.size === 0) return;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = (): void => setWidth(Math.max(320, host.clientWidth));
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(host);
    return () => observer?.disconnect();
  }, []);

  const pointById = React.useMemo(() => {
    const map = new Map<string, MemoryGraphPointView>();
    for (const point of data?.points ?? []) map.set(point.id, point);
    return map;
  }, [data]);

  const nodeById = React.useMemo(() => {
    const map = new Map<string, MemoryGraphNodeView>();
    for (const node of data?.nodes ?? []) map.set(node.id, node);
    return map;
  }, [data]);

  const neighbors = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!hovered) return map;
    const add = (a: string, b: string): void => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)?.add(b);
    };
    for (const edge of data?.edges ?? []) {
      if (edge.from === hovered) add(hovered, edge.to);
      if (edge.to === hovered) add(hovered, edge.from);
    }
    return map;
  }, [data, hovered]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!data || data.nodes.length === 0) {
      ctx.fillStyle = BRAND.linenMuted;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("还没有可展示的记忆", width / 2, height / 2);
      return;
    }

    const scale = Math.min(width, height) / CANVAS_UNITS;
    const project = (p: MemoryGraphPointView): { x: number; y: number } => ({
      x: (p.x - CANVAS_UNITS / 2) * scale + width / 2,
      y: (p.y - CANVAS_UNITS / 2) * scale + height / 2,
    });
    const R = ((CANVAS_UNITS / 2 - 24) * Math.min(width, height)) / CANVAS_UNITS;
    const center = { x: width / 2, y: height / 2 };

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (const ratio of [0.30, 0.54, 0.64, 0.82]) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, ratio * R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    const activeSet = new Set<string>();
    if (hovered) {
      activeSet.add(hovered);
      for (const id of neighbors.get(hovered) ?? []) activeSet.add(id);
    }
    for (const edge of data.edges) {
      const from = pointById.get(edge.from);
      const to = pointById.get(edge.to);
      if (!from || !to) continue;
      const a = project(from);
      const b = project(to);
      const active = !hovered || (activeSet.has(edge.from) && activeSet.has(edge.to));
      ctx.strokeStyle = active
        ? `rgba(138,143,152,${0.18 + edge.strength * 0.35})`
        : "rgba(138,143,152,0.06)";
      ctx.lineWidth = edge.kind === "semantic" ? 1 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const node of data.nodes) {
      const point = pointById.get(node.id);
      if (!point) continue;
      const { x, y } = project(point);
      const radius = Math.max(node.kind === "origin" ? 8 : node.kind === "session" ? 4.5 : 3.5, point.radius * scale * 2.2);
      const dim = Boolean(hovered) && !activeSet.has(node.id);
      ctx.globalAlpha = dim ? 0.18 : alphaOf(node);
      ctx.fillStyle = colorOf(node);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (node.kind === "origin") {
        ctx.globalAlpha = dim ? 0.2 : 0.5;
        ctx.strokeStyle = colorOf(node);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const showLabel =
        node.kind === "origin" ||
        hovered === node.id ||
        (node.kind === "session" && scale > 0.28) ||
        (Boolean(hovered) && activeSet.has(node.id) && node.kind !== "fact");
      if (showLabel) {
        ctx.fillStyle = dim ? "rgba(244,239,230,0.25)" : BRAND.linen;
        ctx.font = node.kind === "origin" ? "600 12px system-ui, sans-serif" : "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        const label = node.kind === "fact" ? node.label.slice(0, 22) : node.label.slice(0, 18);
        // 会话标签沿径向朝外放：贴着圆心放会压住「Loopsoar」。
        if (node.kind === "session") {
          const angle = Math.atan2(y - center.y, x - center.x);
          const off = radius + 14;
          ctx.fillText(label, x + Math.cos(angle) * off, y + Math.sin(angle) * off + 3);
        } else {
          ctx.fillText(label, x, y - radius - 6);
        }
      }
    }
    // E-M2：召回/使用反馈——激活上升的节点画一圈外扩光晕
    const nowMs = performance.now();
    for (const [id, at] of pulsesRef.current) {
      const point = pointById.get(id);
      if (!point) continue;
      const progress = Math.min(1, (nowMs - at) / 700);
      const { x, y } = project(point);
      ctx.strokeStyle = `rgba(200,118,60,${(1 - progress) * 0.75})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(6, point.radius * scale * 2.2) + 4 + progress * 18, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [data, height, hovered, neighbors, pointById, width, tick]);

  const handleMove = React.useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>): void => {
      if (!data) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const scale = Math.min(width, height) / CANVAS_UNITS;
      let best: { id: string; dist: number } | null = null;
      for (const point of data.points) {
        const x = (point.x - CANVAS_UNITS / 2) * scale + width / 2;
        const y = (point.y - CANVAS_UNITS / 2) * scale + height / 2;
        const dist = Math.hypot(mx - x, my - y);
        const radius = Math.max(6, point.radius * scale * 2.2) + 4;
        if (dist <= radius && (!best || dist < best.dist)) best = { id: point.id, dist };
      }
      setHovered(best?.id ?? null);
    },
    [data, height, width],
  );

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height, borderRadius: 10, background: BRAND.inkPanel }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHovered(null)}
        onClick={() => onSelect?.(hovered ? nodeById.get(hovered) ?? null : null)}
      />
      {hovered && nodeById.get(hovered) ? (
        <div style={captionStyle}>{nodeById.get(hovered)?.label}</div>
      ) : null}
    </div>
  );
}

const captionStyle: React.CSSProperties = {
  position: "absolute",
  left: 10,
  bottom: 8,
  maxWidth: "70%",
  padding: "3px 8px",
  borderRadius: 6,
  background: "rgba(17,19,24,0.82)",
  color: "#f4efe6",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
