/**
 * 搜索 / Vibecoding 模式的小型外部 store。
 *
 * 为什么不是 App state：App 是体量守卫的组合根（只降不升），而这个模式同时被
 * 「新建页拨片」和「侧栏顶部开关」读写；用一个模块级 store 让两处直接共享，
 * 不必在 App 里再加一份 state 和两条 props。
 */
import { useSyncExternalStore } from "react";

export type StartMode = "search" | "vibe";

let current: StartMode = "search";
const listeners = new Set<() => void>();

export function setStartMode(mode: StartMode): void {
  if (current === mode) return;
  current = mode;
  for (const listener of listeners) listener();
}

export function useStartMode(): StartMode {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => listeners.delete(onStoreChange);
    },
    () => current,
    () => current,
  );
}
