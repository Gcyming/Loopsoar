/**
 * 模型选择器的状态所有权（从 App 拆出）。
 *
 * 负责：菜单开合、跨供应商模型清单预载、切换模型、当前模型的推理档位。
 * 切换失败只提示，不抛出；供应商配置的持久化仍由 api.settings 负责。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildModelGroups, type ModelGroup } from "./modelGroups.js";
import type { LoopsoarAPI, ProviderStatus } from "./types.js";

export interface UseModelPickerOptions {
  api: LoopsoarAPI | null;
  provider: ProviderStatus | null;
  setProvider: (provider: ProviderStatus) => void;
  setNotice: (notice: string) => void;
  openSettings: (tab?: string) => void;
}

export function useModelPicker({ api, provider, setProvider, setNotice, openSettings }: UseModelPickerOptions) {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelGroups, setModelGroups] = useState<ModelGroup[] | null>(null);
  const loadingRef = useRef(false);
  const reloadQueuedRef = useRef(false);

  const loadGroups = useCallback((): void => {
    if (!api) return;
    // 并发刷新只保留一次尾部请求：供应商保存事件/窗口聚焦/打开菜单可能同时触发，
    // 旧实现会在 loadingRef 为 true 时直接丢弃后到的刷新，列表就停在旧配置上。
    const run = (): void => {
      if (loadingRef.current) {
        reloadQueuedRef.current = true;
        return;
      }
      loadingRef.current = true;
      void api.settings
        .listProviders()
        .then((result) => setModelGroups(buildModelGroups(result.items, result.activeId)))
        .catch(() => setModelGroups([]))
        .finally(() => {
          loadingRef.current = false;
          if (reloadQueuedRef.current) {
            reloadQueuedRef.current = false;
            run();
          }
        });
    };
    run();
  }, [api]);

  // 新标签页 Vibecoding 的模型胶囊要立刻能展开：启动后预载一次跨供应商模型清单（离线、只读本地）。
  useEffect(() => {
    if (!api || modelGroups !== null) return;
    loadGroups();
  }, [api, loadGroups, modelGroups]);

  // 供应商保存后主动刷新模型清单；窗口重新聚焦时做一次懒刷新。
  // 不再在打开菜单时清空旧列表：先展示已有模型，后台拿到最新清单再替换，避免每次打开都闪加载态。
  useEffect(() => {
    if (!api || typeof window === "undefined") return;
    const refresh = (): void => loadGroups();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") loadGroups();
    };
    window.addEventListener("loopsoar:providers-changed", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("loopsoar:providers-changed", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, loadGroups]);

  const openModelMenu = useCallback((): void => {
    if (!api || !provider?.configured) {
      openSettings("providers");
      return;
    }
    if (modelMenuOpen) {
      setModelMenuOpen(false);
      return;
    }
    setModelMenuOpen(true);
    // 打开时后台刷新最新清单；保留旧清单做 stale-while-revalidate，避免「点了先空白再加载」。
    loadGroups();
  }, [api, loadGroups, modelMenuOpen, openSettings, provider]);

  const chooseModel = useCallback(
    (modelId: string, providerId: string): void => {
      setModelMenuOpen(false);
      if (!api) return;
      const group = modelGroups?.find((item) => item.providerId === providerId);
      if (!group) return;
      void (async () => {
        if (!group.active) await api.settings.setActiveProvider({ id: providerId });
        await api.settings.setProvider({ provider: group.provider, baseUrl: group.baseUrl, model: modelId });
        const nextProvider = await api.settings.getProvider();
        setProvider(nextProvider);
        const list = await api.settings.listProviders().catch(() => null);
        if (list) setModelGroups(buildModelGroups(list.items, list.activeId));
        setNotice(`已切换到 ${group.provider} · ${modelId}`);
      })().catch((err: unknown) => setNotice(`切换模型失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api, modelGroups, setNotice, setProvider],
  );

  // 当前模型声明的推理等级；未声明时给默认三档（关=不发参数，安全）。
  const effortOptions = useMemo(() => {
    const spec = provider?.models?.find((m) => m.id === provider.model);
    return spec?.thinkingEfforts && spec.thinkingEfforts.length > 0 ? spec.thinkingEfforts : ["low", "medium", "high"];
  }, [provider]);

  // 档位名直接用模型声明的值（low / medium / high / max …），关闭态显示 off。
  const effortLabel = useCallback((value: string): string => (value ? value : "off"), []);

  return {
    modelMenuOpen,
    setModelMenuOpen,
    modelGroups,
    openModelMenu,
    chooseModel,
    effortOptions,
    effortLabel,
  };
}
