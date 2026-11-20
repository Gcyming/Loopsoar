/**
 * 扩展兼容性检查（纯逻辑）：API 大版本、engines 范围、权限/隔离风险、清单自洽性。
 *
 * 这是「兼容性认证」的判定核心：安装器、宿主扫描、运行时启动都消费同一份报告，
 * 避免出现「设置页说兼容、启动时又拒绝」的两套标准。
 */
import {
  EXTENSION_HOST_API_VERSION,
  type ExtensionManifest,
} from "loopsoar-contracts/extension";
import { isValidRange, parseSemVer, satisfies } from "./semver.js";

export type ExtensionCompatibilityStatus = "compatible" | "compatible-with-warnings" | "blocked";
export type ExtensionCompatibilityLevel = "error" | "warning" | "info";

export interface ExtensionCompatibilityIssue {
  code: string;
  level: ExtensionCompatibilityLevel;
  message: string;
}

export interface ExtensionCompatibility {
  status: ExtensionCompatibilityStatus;
  hostApiVersion: string;
  hostVersion: string;
  apiVersion: string;
  engineRange: string | null;
  legacyApi: boolean;
  issues: ExtensionCompatibilityIssue[];
  errors: number;
  warnings: number;
}

export interface CompatibilityOptions {
  /** 宿主插件 API 版本；默认 contracts 常量。 */
  hostApiVersion?: string;
  /** 宿主应用版本（engines.loopsoar 的比对对象）；默认 0.1.0。 */
  hostVersion?: string;
  /** 严格模式：engines.loopsoar 缺失也算错误（市场认证用）。 */
  requireEngine?: boolean;
}

function issue(level: ExtensionCompatibilityLevel, code: string, message: string): ExtensionCompatibilityIssue {
  return { level, code, message };
}

/**
 * 计算兼容性报告。任何无法解析的版本/范围都 fail-closed（error），
 * 因为「看不懂的约束」不能当作「没有约束」。
 */
export function checkExtensionCompatibility(
  manifest: ExtensionManifest,
  opts: CompatibilityOptions = {},
): ExtensionCompatibility {
  const hostApiVersion = opts.hostApiVersion ?? EXTENSION_HOST_API_VERSION;
  const hostVersion = opts.hostVersion ?? "0.1.0";
  const issues: ExtensionCompatibilityIssue[] = [];

  const hostApi = parseSemVer(hostApiVersion);
  if (!hostApi) {
    issues.push(issue("error", "host-api-invalid", `宿主 API 版本非法：${hostApiVersion}`));
  }

  const apiVersion = manifest.apiVersion ?? "1.0.0";
  const api = parseSemVer(apiVersion);
  if (!api) {
    issues.push(issue("error", "api-invalid", `apiVersion 不是合法 SemVer：${apiVersion}`));
  } else if (hostApi) {
    if (api.major > hostApi.major) {
      issues.push(
        issue(
          "error",
          "api-newer",
          `扩展要求 API ${apiVersion}，宿主仅支持 ${hostApiVersion}；请升级 Loopsoar 或使用旧版扩展`,
        ),
      );
    } else if (api.major < hostApi.major) {
      issues.push(
        issue(
          "warning",
          "api-legacy",
          `扩展按 API ${apiVersion} 编写，宿主为 ${hostApiVersion}；旧接口仍可用但不保证新能力`,
        ),
      );
    }
    if (api.major === 0) {
      issues.push(issue("warning", "api-experimental", "扩展声明 API 0.x（实验性），接口可能变化"));
    }
  }

  const engineRange = manifest.engines?.loopsoar ?? null;
  if (!engineRange) {
    issues.push(
      issue(
        opts.requireEngine ? "error" : "warning",
        "engine-unpinned",
        opts.requireEngine
          ? "缺少 engines.loopsoar（认证要求固定兼容范围）"
          : "未声明 engines.loopsoar，无法预判宿主升级后的兼容性",
      ),
    );
  } else if (!isValidRange(engineRange)) {
    issues.push(issue("error", "engine-range-invalid", `engines.loopsoar 不是合法版本范围：${engineRange}`));
  } else if (!satisfies(hostVersion, engineRange)) {
    issues.push(
      issue(
        "error",
        "engine-mismatch",
        `扩展要求 Loopsoar ${engineRange}，当前宿主 ${hostVersion} 不满足`,
      ),
    );
  }

  if (manifest.version.includes("-")) {
    issues.push(issue("warning", "prerelease", `扩展版本 ${manifest.version} 是预发布版`));
  }

  if (!manifest.main && (manifest.events?.length ?? 0) > 0) {
    issues.push(issue("error", "events-without-main", "声明了 events 但缺少 main 入口，事件钩子无法运行"));
  }

  if (manifest.main && (manifest.permissions?.length ?? 0) === 0) {
    issues.push(
      issue("warning", "no-permissions", "扩展有入口但未声明 permissions：其工具会被 fail-closed 全部拒绝"),
    );
  }

  const requested = new Set(manifest.permissions ?? []);
  if (
    manifest.main &&
    manifest.isolation !== "node" &&
    manifest.isolation !== "strict" &&
    (requested.has("write") || requested.has("terminal") || requested.has("network"))
  ) {
    issues.push(
      issue(
        "warning",
        "unsandboxed-capabilities",
        "扩展申请 write/terminal/network 但未启用 isolation，worker 拥有完整 Node 权限",
      ),
    );
  }

  const eventCount = manifest.events?.length ?? 0;
  if (eventCount > 0 && !requested.has("events")) {
    issues.push(issue("error", "events-not-permitted", "声明了 events 但 permissions 未包含 events"));
  }

  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dep === manifest.id) issues.push(issue("error", "self-dependency", "扩展不能依赖自身"));
    if (!isValidRange(range)) {
      issues.push(issue("error", "dependency-range-invalid", `依赖 ${dep} 的版本范围非法：${range}`));
    }
  }

  for (const view of manifest.contributes?.views ?? []) {
    if (!view.entry.toLowerCase().endsWith(".html") && !view.entry.toLowerCase().endsWith(".htm")) {
      issues.push(issue("warning", "view-not-html", `视图 ${view.id} 的入口不是 .html：${view.entry}`));
    }
  }

  const errors = issues.filter((item) => item.level === "error").length;
  const warnings = issues.filter((item) => item.level === "warning").length;
  return {
    status: errors > 0 ? "blocked" : warnings > 0 ? "compatible-with-warnings" : "compatible",
    hostApiVersion,
    hostVersion,
    apiVersion,
    engineRange,
    legacyApi: Boolean(api && hostApi && api.major < hostApi.major),
    issues,
    errors,
    warnings,
  };
}
