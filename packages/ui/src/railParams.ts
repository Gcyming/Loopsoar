/**
 * 卷轴参数（移植自 slime 的 railParams.ts，按 Loopsoar 需求裁剪）。
 * 持久化在 localStorage；通过 window 事件即时广播，聊天区与外观设置页共用同一份参数。
 *
 * 默认值直接采用 slime wave 模式的出厂值（w/lam0/lam1/amp/spd/tap），
 * 保证「蓝白双股编织麻花」的观感与参考作品一致；用户自定义值仍然保留。
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
  w: 12,
  amp: 55,
  lam0: 46,
  lam1: 53,
  spd: 1,
  flip: false,
  pause: true,
  tap: 90,
};

export const RAIL_PARAMS_EVENT = "loopsoar:rail-params";
/**
 * 存储键升级到 v2：旧版（细线/编织）参数不再复用，否则用户 localStorage 里的
 * 旧 w/amp/lam 会把新外观覆盖回去。已知代价：升级后用户自定义的卷轴参数会回到默认值。
 */
const STORAGE_KEY = "loopsoar_rail_params_chat_v2";
const LEGACY_STORAGE_KEY = "loopsoar_rail_params_chat";

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
    if (!raw) {
      // 清掉旧版参数键，避免以后被旧代码/旧页面再次写回干扰新外观。
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return { ...DEFAULT_CHAT_RAIL };
    }
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
