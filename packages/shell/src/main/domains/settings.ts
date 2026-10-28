/**
 * settings 域：模型服务商配置读写（非机密字段）。
 * 密钥纪律：apiKey 永不落盘、永不回传 IPC；本域只报告「环境变量是否已提供密钥」。
 * 首启无配置属正常态（loadProviderConfig 返回 null，不抛错）。
 */
import path from "node:path";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import {
  validateProviderConfig,
  resolveApiKeyFromEnv,
  providerUsability,
  type ProviderConfig,
} from "loopsoar-core/provider";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface SettingsDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
  configDir: string;
  env: Record<string, string | undefined>;
}

/** provider 配置文件路径（%APPDATA%\loopsoar\config\provider.json）。 */
export function providerConfigPath(configDir: string): string {
  return path.join(configDir, "provider.json");
}

/** 读取 provider 配置；不存在/损坏 → null（损坏时静默降级为首启，避免卡死启动）。 */
export async function loadProviderConfig(
  platform: LoopsoarPlatform,
  configDir: string,
): Promise<ProviderConfig | null> {
  const file = providerConfigPath(configDir);
  try {
    if (!(await platform.fs.exists(file))) return null;
    const raw = await platform.fs.readFileUtf8(file);
    return validateProviderConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function registerSettingsDomain(deps: SettingsDeps): void {
  handleTrusted(deps, "settings:getProvider", async () => {
    const cfg = await loadProviderConfig(deps.platform, deps.configDir);
    const apiKey = resolveApiKeyFromEnv(deps.env);
    const usability = providerUsability(cfg, apiKey);
    return {
      configured: cfg !== null,
      provider: cfg?.provider ?? null,
      baseUrl: cfg?.baseUrl ?? null,
      model: cfg?.model ?? null,
      hasApiKey: apiKey.length > 0,
      usable: usability.usable,
      reason: usability.reason ?? null,
    };
  });

  handleTrusted(deps, "settings:setProvider", async (payload) => {
    const cfg = validateProviderConfig(payload);
    await deps.platform.fs.writeFileUtf8(
      providerConfigPath(deps.configDir),
      JSON.stringify(cfg, null, 2),
    );
    const apiKey = resolveApiKeyFromEnv(deps.env);
    const usability = providerUsability(cfg, apiKey);
    return { saved: true, config: cfg, usable: usability.usable, reason: usability.reason ?? null };
  });
}
