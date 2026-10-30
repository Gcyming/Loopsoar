/**
 * 卷轴参数（移植自 slime 的 railParams.ts，按 Loopsoar 需求裁剪）。
 * 持久化在 localStorage；通过 window 事件即时广播，聊天区与外观设置页共用同一份参数。
 */
export interface RailParams {
  /** 卷轴宽度（px） */
  w: number;
  /** 常态振幅（占波形带宽百分比） */
  amp: number;
  /** 亮线波长（px） */
  lam0: number;
  /** 暗线波长（px） */
  lam1: number;
  /** 荡漾速度（0=静止） */
  spd: number;
  /** 衬托方向翻转 */
  flip: boolean;
  /** 悬停时暂停荡漾 */
  pause: boolean;
  /** 两端渐隐长度（px） */
  tap: number;
}

export const DEFAULT_CHAT_RAIL: RailParams = {
  w: 16,
  amp: 48,
  lam0: 86,
  lam1: 112,
  spd: 0.8,
  flip: false,
  pause: true,
  tap: 130,
};

export const RAIL_PARAMS_EVENT = "loopsoar:rail-params";
const STORAGE_KEY = "loopsoar_rail_params_chat";

const NUM_RANGES: Record<string, [number, number]> = {
  w: [6, 32],
  amp: [0, 100],
  lam0: [8, 400],
  lam1: [8, 400],
  spd: [0, 4],
  tap: [0, 400],
};

export function normalizeRailParams(input: unknown, base: RailParams = DEFAULT_CHAT_RAIL): RailParams {
  const out: RailParams = { ...base };
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof RailParams>) {
    const value = src[key];
    if (typeof value === "boolean" && typeof base[key] === "boolean") {
      (out as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const range = NUM_RANGES[key as string];
      (out as unknown as Record<string, unknown>)[key] = range ? Math.min(range[1], Math.max(range[0], value)) : value;
    }
  }
  return out;
}

export function loadRailParams(): RailParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHAT_RAIL };
    return normalizeRailParams(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CHAT_RAIL };
  }
}

export function saveRailParams(patch: Partial<RailParams>): RailParams {
  const next = normalizeRailParams({ ...loadRailParams(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 忽略（隐私模式等）
  }
  try {
    window.dispatchEvent(new CustomEvent(RAIL_PARAMS_EVENT, { detail: next }));
  } catch {
    // 忽略
  }
  return next;
}

export function onRailParams(cb: (params: RailParams) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<RailParams>).detail;
    cb(normalizeRailParams(detail ?? loadRailParams()));
  };
  window.addEventListener(RAIL_PARAMS_EVENT, handler);
  return () => window.removeEventListener(RAIL_PARAMS_EVENT, handler);
}
