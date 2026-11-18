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

  handleTrusted(deps, "skills:openDir", async () => {
    const ok = (await deps.openSkillsDir?.()) ?? false;
    return { ok, dir: deps.skills?.dirPath() ?? "" };
  });
}
