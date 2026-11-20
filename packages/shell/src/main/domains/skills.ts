/**
 * skills 域：技能（SKILL.md）的发现/启停 —— 与 extensions、mcp 独立。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { SkillHost } from "../skills.js";

export interface SkillsDeps extends TrustedIpcDeps {
  skills?: SkillHost;
  /** 打开技能目录（index 注入 shell.openPath）。 */
  openSkillsDir?: () => Promise<boolean>;
  push?: (event: string, payload: unknown) => void;
}

export function registerSkillsDomain(deps: SkillsDeps): void {
  handleTrusted(deps, "skills:list", () => {
    if (!deps.skills) return { skills: [], dir: "", skipped: [] };
    const scan = deps.skills.scan();
    return { skills: deps.skills.list(), dir: deps.skills.dirPath(), skipped: scan.skipped };
  });

  handleTrusted(deps, "skills:reload", () => {
    const scan = deps.skills?.scan() ?? { installed: 0, skipped: [] };
    deps.push?.("skills:updated", { action: "reload", installed: scan.installed });
    return { skills: deps.skills?.list() ?? [], skipped: scan.skipped };
  });

  handleTrusted(deps, "skills:setEnabled", (payload) => {
    const p = payload as { id: string; enabled: boolean };
    const item = deps.skills?.setEnabled(p.id, p.enabled) ?? null;
    deps.push?.("skills:updated", { id: p.id, enabled: p.enabled });
    return { ok: item !== null, skill: item };
  });

  handleTrusted(deps, "skills:remove", (payload) => {
    const p = payload as { id: string };
    const ok = deps.skills?.remove(p.id) ?? false;
    if (ok) deps.push?.("skills:updated", { action: "remove", id: p.id });
    return { ok };
  });

  /**
   * 资源包安装：把用户选中的目录整体复制进技能库（scripts/references/assets 一并带走）。
   * 路径选择在渲染层用 dialog.pickPath 完成；这里只做校验/复制/重扫。
   */
  handleTrusted(deps, "skills:import", (payload) => {
    const p = payload as { sourcePath: string; id?: string; overwrite?: boolean };
    const result = deps.skills?.importSkill(p.sourcePath, { id: p.id, overwrite: p.overwrite }) ?? {
      ok: false,
      error: "技能宿主未初始化",
    };
    if (result.ok) deps.push?.("skills:updated", { action: "import", id: result.id });
    return { ...result, skills: deps.skills?.list() ?? [] };
  });

  handleTrusted(deps, "skills:openDir", async () => {
    const ok = (await deps.openSkillsDir?.()) ?? false;
    return { ok, dir: deps.skills?.dirPath() ?? "" };
  });
}
