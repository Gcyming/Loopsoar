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

  const loadGroups = useCallback((): void => {
    if (!api || loadingRef.current) return;
    loadingRef.current = true;
    void api.settings
      .listProviders()
      .then((result) => setModelGroups(buildModelGroups(result.items, result.activeId)))
      .catch(() => setModelGroups([]))
      .finally(() => {
        loadingRef.current = false;
      });
  }, [api]);

  // 新标签页 Vibecoding 的模型胶囊要立刻能展开：启动后预载一次跨供应商模型清单（离线、只读本地）。
  useEffect(() => {
    if (!api || modelGroups !== null) return;
    loadGroups();
  }, [api, loadGroups, modelGroups]);

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
    setModelGroups(null); // 打开时拉最新清单，避免设置页改过后仍显示旧模型
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
