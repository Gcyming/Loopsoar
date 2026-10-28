/**
 * Provider 配置模型（纯逻辑，零 node 依赖）。
 * 为什么单独建模：provider 配置决定「模型服务指向谁」，是跨模块共享的稳定结构；
 * 校验放在这里，避免各装配点各自解析产生不一致。
 * 密钥纪律：apiKey 永远不进本模型、不落盘——P3 加密存储落地前只从环境变量读取（见 docs/ISOLATION.md）。
 */
import { z } from "zod";

export const ProviderConfigSchema = z.object({
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** 校验并归一 provider 配置；失败抛可读错误（含字段名）。 */
export function validateProviderConfig(raw: unknown): ProviderConfig {
  const parsed = ProviderConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("；");
    throw new Error(`provider 配置非法：${detail}`);
  }
  return {
    provider: parsed.data.provider.trim(),
    baseUrl: parsed.data.baseUrl.replace(/\/+$/, ""),
    model: parsed.data.model.trim(),
  };
}

/** 环境变量里的密钥（不落盘）：LOOPSOAR_API_KEY 优先，兼容 OPENAI_API_KEY。 */
export function resolveApiKeyFromEnv(env: Record<string, string | undefined>): string {
  return env.LOOPSOAR_API_KEY || env.OPENAI_API_KEY || "";
}

/** 判断配置+密钥是否足以发起真实 LLM 调用；不可用时给出可读原因（不抛错，供状态展示）。 */
export function providerUsability(
  config: ProviderConfig | null,
  apiKey: string,
): { usable: boolean; reason?: string } {
  if (!config) return { usable: false, reason: "尚未配置模型服务商（设置 → 模型服务）" };
  if (!apiKey) return { usable: false, reason: "缺少 API Key（环境变量 LOOPSOAR_API_KEY / OPENAI_API_KEY）" };
  return { usable: true };
}
