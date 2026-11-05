/**
 * 卷轴参数（移植自 slime 的 railParams.ts，按 Loopsoar 需求裁剪）。
 * 持久化在 localStorage；通过 window 事件即时广播，聊天区与外观设置页共用同一份参数。
 *
 * 默认值保持 Loopsoar 原版细线外观的参数（w16/amp48/lam0 86/lam1 112/spd0.8/tap130）；
 * 卷轴的「突起」交互借鉴 slime，但静态外观以 Loopsoar 原设计为准（用户 2026-11-05 反馈）。
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
  /** 悬停突起幅度（px，指针处线向外鼓出的最大位移） */
  bumpReach: number;
  /** 悬停突起紧凑度（px，高斯宽度；越小越紧凑） */
  bumpSigma: number;
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
  // 突起参数（ADR-0032）：默认值 = 原版外观 + 更紧凑的 slime 式悬停突起。
  bumpReach: 13,
  bumpSigma: 13,
};

export const RAIL_PARAMS_EVENT = "loopsoar:rail-params";
/**
 * 存储键升级到 v3：v2 曾写入「slime wave 重做」那版的默认参数（w12/lam46/53…），
 * 而当前外观已回退到原版细线（w16/lam86/112），必须换键清掉 v2 的遗留值，
 * 否则用户 localStorage 里的旧参数会把外观继续固定在错误形态。
 * 已知代价：升级后用户自定义的卷轴参数会回到默认值。
 * 注意：v3 之后新增的 `bumpReach` / `bumpSigma` 由 normalizeRailParams 自动补默认值，
 * 老 v3 数据不需要再换键（否则会把用户已调好的 6 个参数一起重置）。
 */
const STORAGE_KEY = "loopsoar_rail_params_chat_v3";
const LEGACY_STORAGE_KEYS = ["loopsoar_rail_params_chat_v2", "loopsoar_rail_params_chat"];

const NUM_RANGES: Record<string, [number, number]> = {
  w: [6, 32],
  amp: [0, 100],
  lam0: [8, 400],
  lam1: [8, 400],
  spd: [0, 4],
  tap: [0, 400],
  bumpReach: [4, 24],
  bumpSigma: [8, 32],
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
      // 清掉旧版参数键，避免历史默认值（v2 的 slime 编织参数）继续干扰当前外观。
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
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
