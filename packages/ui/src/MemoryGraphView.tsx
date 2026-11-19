/**
 * 记忆图谱渲染（E-M0 2D / E-M2 脉冲 / 3D 视图）：Canvas 2D 自绘，零第三方依赖。
 *
 * 2D：环带布局，原点在中心，会话第一圈，事实挂会话扇区，无会话事实落外圈。
 * 3D：把环带当成一个略有厚度的圆盘做透视投影（外圈更远），拖拽旋转、滚轮缩放；
 *     节点按深度排序绘制（画家算法），大小按透视缩放。
 * 两种视图共享同一份数据与命中测试，切换只改投影参数。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { useT } from "./i18n.js";
import type { MemoryGraphNodeView, MemoryGraphPointView, MemoryGraphResult } from "./types.js";

export interface MemoryGraphViewProps {
  data: MemoryGraphResult | null;
  height?: number;
  onSelect?: (node: MemoryGraphNodeView | null) => void;
}

const CANVAS_UNITS = 1000;
const MODE_KEY = "loopsoar.memoryGraph.mode";
const COLORS = { origin: "#c8763c", session: "#5b8def", fact: "#9aa4b2", drift: "#5eead4" };

function colorOf(node: MemoryGraphNodeView | undefined): string {
  if (!node) return COLORS.fact;
  if (node.kind === "origin") return COLORS.origin;
  if (node.kind === "session") return COLORS.session;
  return node.band === "L1" ? COLORS.fact : COLORS.drift;
}

function alphaOf(node: MemoryGraphNodeView): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, node.activation));
}

function readMode(): "2d" | "3d" {
  try {
    return window.localStorage.getItem(MODE_KEY) === "3d" ? "3d" : "2d";
  } catch {
    return "2d";
  }
}

export default function MemoryGraphView({ data, height = 380, onSelect }: MemoryGraphViewProps): React.JSX.Element {
  const tr = useT();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [width, setWidth] = React.useState(720);
  const [mode, setMode] = React.useState<"2d" | "3d">(() => readMode());
  const [yaw, setYaw] = React.useState(-0.45);
  const [pitch, setPitch] = React.useState(0.62);
  const [zoom, setZoom] = React.useState(1);
  const dragRef = React.useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  const pulsesRef = React.useRef(new Map<string, number>());
  const prevActivationRef = React.useRef(new Map<string, number>());
  const [tick, setTick] = React.useState(0);

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

  const project = React.useCallback(
    (point: MemoryGraphPointView): { x: number; y: number; scale: number; depth: number } => {
      const nx = point.x - CANVAS_UNITS / 2;
      const ny = point.y - CANVAS_UNITS / 2;
      if (mode === "2d") {
        const scale = Math.min(width, height) / CANVAS_UNITS;
        return { x: width / 2 + nx * scale, y: height / 2 + ny * scale, scale, depth: 0 };
      }
      // 3D：圆盘外圈更远（z<0），先绕 Y 旋转，再绕 X 俯仰，最后做透视除法。
      const radius = Math.hypot(nx, ny);
      // 用 id 的确定性散列给每点一点 z 抖动：同半径的点不再共面，圆盘才有厚度
      let seed = 7;
      for (let i = 0; i < point.id.length; i += 1) seed = (seed * 31 + point.id.charCodeAt(i)) % 9973;
      const z0 = -radius * 0.55 + ((seed % 200) - 100) * 3.2;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const x1 = nx * cy + z0 * sy;
      const z1 = -nx * sy + z0 * cy;
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const y1 = ny * cp - z1 * sp;
      const z2 = ny * sp + z1 * cp;
      const focal = 1150;
      const perspective = focal / Math.max(200, focal - z2);
      const base = (Math.min(width, height) / CANVAS_UNITS) * 1.5 * zoom;
      return {
        x: width / 2 + x1 * base * perspective,
        y: height / 2 + y1 * base * perspective,
        scale: base * perspective,
        depth: z2,
      };
    },
    [height, mode, pitch, width, yaw, zoom],
  );

  // E-M2：激活值上升的节点脉冲 750ms
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
      for (const [id, at] of pulsesRef.current) if (t - at > 750) pulsesRef.current.delete(id);
      setTick((value) => value + 1);
      if (pulsesRef.current.size === 0) return;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  // 滚轮缩放：React 的 onWheel 是 passive，preventDefault 无效，会连带滚动整页；
  // 这里用原生非 passive 监听，缩放时阻止页面滚动。
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((value) => Math.max(0.5, Math.min(2.6, value * (event.deltaY > 0 ? 0.92 : 1.08))));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

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

    const center = { x: width / 2, y: height / 2 };
    // 环带参考线只在 2D 画（3D 里圆环投影后是椭圆，容易误导）
    if (mode === "2d") {
      const R = ((CANVAS_UNITS / 2 - 24) * Math.min(width, height)) / CANVAS_UNITS;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (const ratio of [0.3, 0.54, 0.64, 0.82]) {
        ctx.beginPath();
        ctx.arc(center.x, center.y, ratio * R, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    const activeSet = new Set<string>();
    if (hovered) {
      activeSet.add(hovered);
      for (const id of neighbors.get(hovered) ?? []) activeSet.add(id);
    }

    // 边（先画，节点覆盖在上面）
    for (const edge of data.edges) {
      const from = pointById.get(edge.from);
      const to = pointById.get(edge.to);
      if (!from || !to) continue;
      const a = project(from);
      const b = project(to);
      const active = !hovered || (activeSet.has(edge.from) && activeSet.has(edge.to));
      const depthFade = mode === "3d" ? Math.max(0.25, Math.min(1, 1 + (a.depth + b.depth) / 4000)) : 1;
      ctx.strokeStyle = active
        ? `rgba(138,143,152,${(0.18 + edge.strength * 0.35) * depthFade})`
        : "rgba(138,143,152,0.06)";
      ctx.lineWidth = edge.kind === "semantic" ? 1 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 标签收集后按优先级单独放置，遇到重叠就跳过，避免节点密集时糊成一片
    const labelCandidates: { id: string; kind: string; text: string; x: number; y: number; radius: number; dim: boolean; visible: boolean; priority: number; superseded: boolean }[] = [];
    // 节点按深度从远到近画（3D 画家算法；2D 保持稳定顺序）
    const ordered = [...data.nodes].sort((a, b) => {
      if (mode !== "3d") return a.id.localeCompare(b.id);
      const pa = pointById.get(a.id);
      const pb = pointById.get(b.id);
      return (pa ? project(pa).depth : 0) - (pb ? project(pb).depth : 0);
    });

    for (const node of ordered) {
      const point = pointById.get(node.id);
      if (!point) continue;
      const projected = project(point);
      const { x, y } = projected;
      const baseRadius = Math.max(node.kind === "origin" ? 8 : node.kind === "session" ? 4.5 : 3.5, point.radius * projected.scale * 2.2);
      const depthAlpha = mode === "3d" ? Math.max(0.35, Math.min(1, 1 + projected.depth / 5000)) : 1;
      const dim = Boolean(hovered) && !activeSet.has(node.id);
      // M4 回放：当时已失效的条目画成空心环，仍留在图上，能看出「它曾经存在过」。
      const ghost = node.superseded === true;
      ctx.globalAlpha = (dim ? 0.18 : alphaOf(node)) * depthAlpha * (ghost ? 0.55 : 1);
      ctx.fillStyle = colorOf(node);
      ctx.beginPath();
      ctx.arc(x, y, baseRadius, 0, Math.PI * 2);
      if (ghost) {
        ctx.strokeStyle = colorOf(node);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fill();
      }
      if (node.kind === "origin") {
        ctx.globalAlpha = dim ? 0.2 : 0.5;
        ctx.strokeStyle = colorOf(node);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, baseRadius + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      labelCandidates.push({
        id: node.id,
        kind: node.kind,
        text: node.label,
        x,
        y,
        radius: baseRadius,
        dim,
        visible:
          node.kind === "origin" ||
          hovered === node.id ||
          (node.kind === "session" && projected.scale > 0.22) ||
          (Boolean(hovered) && activeSet.has(node.id) && node.kind !== "fact"),
        priority: node.kind === "origin" ? 0 : node.kind === "session" ? 1 : hovered === node.id ? 1.5 : 3,
        superseded: node.superseded === true,
      });
    }

    // 标签：按优先级放置，测出包围盒，与已放置的重叠就放弃
    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
    labelCandidates.sort((a, b) => a.priority - b.priority);
    for (const candidate of labelCandidates) {
      if (!candidate.visible) continue;
      const label =
        (candidate.kind === "fact" ? candidate.text.slice(0, 22) : candidate.text.slice(0, 18)) +
        (candidate.superseded ? " · 已失效" : "");
      ctx.font = candidate.kind === "origin" ? "600 12px system-ui, sans-serif" : "11px system-ui, sans-serif";
      const anchorAngle = Math.atan2(candidate.y - center.y, candidate.x - center.x);
      const offset = candidate.radius + 14;
      const lx = candidate.kind === "session" ? candidate.x + Math.cos(anchorAngle) * offset : candidate.x;
      const ly =
        candidate.kind === "session"
          ? candidate.y + Math.sin(anchorAngle) * offset + 3
          : candidate.y - candidate.radius - 6;
      const size = ctx.measureText(label).width;
      const rect =
        candidate.kind === "session"
          ? { x1: lx - size / 2, y1: ly - 10, x2: lx + size / 2, y2: ly + 2 }
          : { x1: lx - size / 2, y1: ly - 9, x2: lx + size / 2, y2: ly + 2 };
      const hit = placed.some((p) => rect.x1 < p.x2 && rect.x2 > p.x1 && rect.y1 < p.y2 && rect.y2 > p.y1);
      if (hit) continue;
      placed.push(rect);
      ctx.fillStyle = candidate.dim ? "rgba(244,239,230,0.25)" : BRAND.linen;
      ctx.textAlign = "center";
      ctx.fillText(label, lx, ly);
    }

    // E-M2：召回/使用反馈
    const nowMs = performance.now();
    for (const [id, at] of pulsesRef.current) {
      const point = pointById.get(id);
      if (!point) continue;
      const progress = Math.min(1, (nowMs - at) / 700);
      const projected = project(point);
      ctx.strokeStyle = `rgba(200,118,60,${(1 - progress) * 0.75})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, Math.max(6, point.radius * projected.scale * 2.2) + 4 + progress * 18, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [data, height, hovered, mode, neighbors, pointById, project, tick, width]);

  const hitTest = React.useCallback(
    (mx: number, my: number): string | null => {
      if (!data) return null;
      let best: { id: string; dist: number } | null = null;
      for (const point of data.points) {
        const projected = project(point);
        const dist = Math.hypot(mx - projected.x, my - projected.y);
        const radius = Math.max(6, point.radius * projected.scale * 2.2) + 4;
        if (dist <= radius && (!best || dist < best.dist)) best = { id: point.id, dist };
      }
      return best?.id ?? null;
    },
    [data, project],
  );

  const changeMode = React.useCallback((next: "2d" | "3d") => {
    setMode(next);
    setYaw(-0.45);
    setPitch(0.62);
    setZoom(1);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
  }, []);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height,
          borderRadius: 10,
          background: BRAND.inkPanel,
          cursor: mode === "3d" ? (dragRef.current.active ? "grabbing" : "grab") : "default",
        }}
        onMouseDown={(event) => {
          if (mode !== "3d") return;
          dragRef.current = { active: true, x: event.clientX, y: event.clientY };
        }}
        onMouseUp={() => {
          dragRef.current.active = false;
        }}
        onMouseLeave={() => {
          dragRef.current.active = false;
          setHovered(null);
        }}
        onMouseMove={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          if (mode === "3d" && dragRef.current.active) {
            const dx = event.clientX - dragRef.current.x;
            const dy = event.clientY - dragRef.current.y;
            dragRef.current.x = event.clientX;
            dragRef.current.y = event.clientY;
            setYaw((value) => value + dx * 0.008);
            setPitch((value) => Math.max(-1.2, Math.min(1.2, value - dy * 0.006)));
            return;
          }
          const rect = canvas.getBoundingClientRect();
          setHovered(hitTest(event.clientX - rect.left, event.clientY - rect.top));
        }}
        onClick={() => onSelect?.(hovered ? nodeById.get(hovered) ?? null : null)}
      />
      <div style={zoomStyle}>
        <button
          type="button"
          style={zoomButton}
          title="放大"
          onClick={() => setZoom((value) => Math.min(2.6, value * 1.15))}
        >
          +
        </button>
        <button
          type="button"
          style={zoomButton}
          title="缩小"
          onClick={() => setZoom((value) => Math.max(0.5, value / 1.15))}
        >
          −
        </button>
        <button type="button" style={zoomButton} title="恢复 100%" onClick={() => setZoom(1)}>
          1:1
        </button>
      </div>
      <div style={toggleStyle}>
        <button type="button" style={toggleButton(mode === "2d")} onClick={() => changeMode("2d")}>
          2D
        </button>
        <button type="button" style={toggleButton(mode === "3d")} onClick={() => changeMode("3d")}>
          3D
        </button>
      </div>
      {mode === "3d" ? <div style={hintStyle}>{tr("memory.graphHint3d")}</div> : null}
      {hovered && nodeById.get(hovered) ? (
        <div style={captionStyle}>{nodeById.get(hovered)?.label}</div>
      ) : null}
    </div>
  );
}

const zoomStyle: React.CSSProperties = {
  position: "absolute",
  left: 10,
  bottom: 8,
  display: "flex",
  gap: 4,
  padding: 2,
  borderRadius: 8,
  background: "rgba(17,19,24,0.72)",
};
const zoomButton: React.CSSProperties = {
  border: "none",
  borderRadius: 6,
  width: 26,
  height: 24,
  fontSize: 12,
  cursor: "pointer",
  color: "#a8a29a",
  background: "transparent",
};

const toggleStyle: React.CSSProperties = {
  position: "absolute",
  right: 10,
  top: 8,
  display: "flex",
  gap: 4,
  padding: 2,
  borderRadius: 8,
  background: "rgba(17,19,24,0.72)",
};
const toggleButton = (active: boolean): React.CSSProperties => ({
  border: "none",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  color: active ? "#111318" : "#a8a29a",
  background: active ? "#c8763c" : "transparent",
});
const hintStyle: React.CSSProperties = {
  position: "absolute",
  right: 10,
  bottom: 8,
  fontSize: 10,
  color: "rgba(244,239,230,0.45)",
};
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
