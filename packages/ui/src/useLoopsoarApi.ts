import type { LoopsoarAPI } from "./types.js";

/** 读取 preload 暴露的受控 API（非 Electron 环境返回 null）。 */
export function useLoopsoarApi(): LoopsoarAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { loopsoarAPI?: LoopsoarAPI }).loopsoarAPI ?? null;
}
