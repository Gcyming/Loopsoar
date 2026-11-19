/**
 * 扩展贡献主题的应用（第三阶段 C）：从 extensions:list 的 contributions 取主题，
 * 命中偏好里的 theme 时以 soft 为底覆盖白名单 CSS 变量；未命中回落内置主题。
 */
import { useEffect, useState } from "react";
import type { ExtensionContributionsState } from "./types.js";
import { applyContributedTheme, applyTheme } from "./theme.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";

export function useContributedTheme(themeId: string): void {
  const api = useLoopsoarApi();
  const [themes, setThemes] = useState<ExtensionContributionsState["themes"]>([]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const load = (): void => {
      void api.extensions
        .list()
        .then((result) => {
          if (alive) setThemes(result.contributions?.themes ?? []);
        })
        .catch(() => {});
    };
    load();
    const off = api.on("extensions:updated", load);
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  useEffect(() => {
    const custom = themes.find((item) => item.id === themeId);
    if (custom) {
      applyTheme("soft"); // 自定义主题以 soft 为底，只覆盖贡献的 token
      applyContributedTheme(custom.tokens);
      return () => applyContributedTheme(null);
    }
    applyContributedTheme(null);
    applyTheme(themeId === "classic" ? "classic" : "soft");
    return () => applyContributedTheme(null);
  }, [themeId, themes]);
}
