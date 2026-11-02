/**
 * 生成脚本（唯一产地）。
 * 读取 contracts 包的唯一产地文件（schemas、security-policy），
 * 生成三个生成物到 gen/ 目录（入库）。
 * 用法：pnpm --filter loopsoar-contracts gen（或直接 tsx scripts/gen.ts）
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CHANNEL_BINDINGS, EVENTS } from "../src/schemas.js";
import * as policy from "../src/security-policy.js";

/**
 * 确保目标目录存在。
 */
function ensureDir(p: string) {
  const d = dirname(p);
  if (!existsSync(d)) {
    mkdirSync(d, { recursive: true });
  }
}

/**
 * 生成 ipc-manifest.json（通道清单 + 事件名列表）。
 */
export function generateIpcManifest() {
  const channels = Object.entries(CHANNEL_BINDINGS).map(
    ([channel, binding]) => ({
      channel,
      domain: binding.domain,
      method: binding.method,
      sensitive: binding.sensitive,
      hasRequest: binding.request !== null,
    })
  );
  const manifest = {
    channels,
    events: [...EVENTS],
  };
  const outPath = resolve("gen", "ipc-manifest.json");
  ensureDir(outPath);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("生成: " + outPath);
}

/**
 * 生成 ipc.ts（IPC 常量、类型、白名单构造器、事件名）。
 */
export function generateIpcTs() {
  const outPath = resolve("gen", "ipc.ts");
  ensureDir(outPath);

  // 构造 IPC_CHANNELS（常量对象）
  const ipcChannelsEntries = Object.entries(CHANNEL_BINDINGS)
    .map(
      ([channel, binding]) => `  "${channel}": { domain: "${binding.domain}", method: "${binding.method}", sensitive: ${binding.sensitive}, hasRequest: ${binding.request !== null ? "true" : "false"} },`
    )
    .join("\n");

  // 构造 buildPreloadWhitelist 函数（domain → method[]，直接由 CHANNEL_BINDINGS 推导）
  const domainToMethods = new Map<string, Set<string>>();
  for (const [channel, binding] of Object.entries(CHANNEL_BINDINGS)) {
    if (!domainToMethods.has(binding.domain)) domainToMethods.set(binding.domain, new Set());
    domainToMethods.get(binding.domain)!.add(binding.method);
  }
  const preloadEntries = Array.from(domainToMethods.entries())
    .map(
      ([domain, methods]) => `    "${domain}": [${Array.from(methods).map((m) => `"${m}"`).join(", ")}]`
    )
    .join(",\n");

  const content = `/**
 * 生成文件：由 scripts/gen.ts 生成，不可手动修改。
 * 唯一产地：packages/contracts/src/schemas.ts 与 src/security-policy.ts。
 */

import { z } from "zod";
import { CHANNEL_BINDINGS } from "../src/schemas.js";

/**
 * IPC_CHANNELS：通道常量对象（通道名 → 元数据）。
 */
export const IPC_CHANNELS = {
${ipcChannelsEntries}
} as const;

/**
 * IpcRequest 包装类型：通道名 + 载荷。
 */
export type IpcRequest<T> = {
  readonly channel: string;
  readonly payload: T;
};

/**
 * IPC_VALIDATORS：通道名 → zod 校验器（无参通道为 null）。
 * 与 CHANNEL_BINDINGS 同源（直接由 request 字段推导），
 * 供受信 IPC 入口做四要素校验之「参数合法性」。
 */
export const IPC_VALIDATORS: Record<string, z.ZodTypeAny | null> = Object.fromEntries(
  Object.entries(CHANNEL_BINDINGS).map(([channel, b]) => [channel, b.request]),
) as Record<string, z.ZodTypeAny | null>;

/**
 * buildPreloadWhitelist：根据 CHANNEL_BINDINGS 构建 preload 白名单。
 * 用于 Electron preload 层暴露接口时的域名→方法映射。
 */
export function buildPreloadWhitelist(): { domains: Record<string, string[]> } {
  return {
    domains: {
${preloadEntries}
    },
  };
}

/**
 * EVENT_NAMES：所有事件名列表。
 */
export const EVENT_NAMES = [
${EVENTS.map((e) => `  "${e}",`).join("\n")}
] as const;
`;

  writeFileSync(outPath, content, "utf8");
  console.log("生成: " + outPath);
}

/**
 * 生成 security-policy.json（全量 JSON 序列化）。
 */
export function generateSecurityPolicyJson() {
  const outPath = resolve("gen", "security-policy.json");
  ensureDir(outPath);
  // 手动构造纯数据 JSON，确保与 security-policy.ts 完全一致
  const data = {
    sensitiveFiles: [...policy.SENSITIVE_FILES],
    protectedSourceDirs: [...policy.PROTECTED_SOURCE_DIRS],
    privateNetRanges: (policy.PRIVATE_NET_RANGES as unknown as ReadonlyArray<{
      v: 4 | 6;
      base: readonly number[];
      prefix: number;
    }>).map((r) => ({
      v: r.v,
      base: Array.from(r.base),
      prefix: r.prefix,
    })),
    maxRedirects: policy.MAX_REDIRECTS,
    fileWriteMaxBytes: policy.FILE_WRITE_MAX_BYTES,
    terminalTimeoutMs: policy.TERMINAL_TIMEOUT_MS,
    terminalMaxBytes: policy.TERMINAL_MAX_BYTES,
    heartbeatMs: policy.HEARTBEAT_MS,
    budgetHard: {
      maxRounds: policy.BUDGET_HARD.maxRounds,
      maxToolCalls: policy.BUDGET_HARD.maxToolCalls,
      maxTotalTokens: policy.BUDGET_HARD.maxTotalTokens,
      maxWallClockMs: policy.BUDGET_HARD.maxWallClockMs,
    },
    loopHealth: {
      silentTimeoutMs: policy.LOOP_HEALTH.silentTimeoutMs,
      noProgressRounds: policy.LOOP_HEALTH.noProgressRounds,
    },
    displayLimitDefault: policy.DISPLAY_LIMIT_DEFAULT,
    terminalLimits: {
      maxSessions: policy.TERMINAL_MAX_SESSIONS,
      idleMs: policy.TERMINAL_IDLE_MS,
      bufferBytes: policy.TERMINAL_BUFFER_BYTES,
      inputMaxBytes: policy.TERMINAL_INPUT_MAX_BYTES,
    },
    ssrf: {
      blockedHostnames: [...policy.SSRF_BLOCKED_HOSTNAMES],
      allowedPorts: [...policy.SSRF_ALLOWED_PORTS],
    },
    fileReadMaxBytes: policy.FILE_READ_MAX_BYTES,
  };
  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("生成: " + outPath);
}

// 主执行：直接脚本运行时生成全部产物；被 check.ts 导入时重复生成无害（check 自带备份比对）。
generateIpcManifest();
generateIpcTs();
generateSecurityPolicyJson();
console.log("生成完成。生成物已入库（gen/ 目录）。");
