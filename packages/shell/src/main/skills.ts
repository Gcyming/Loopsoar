/**
 * 技能宿主（壳层）：扫描 <dataDir>/skills/<id>/SKILL.md，启停状态存 <dataDir>/skills.json。
 * 与扩展（extensions/）、MCP（mcp.json）完全独立目录与状态文件。
 */
import fs from "node:fs";
import path from "node:path";
import { SKILL_FILE_NAME, SKILL_MAX_BYTES, SkillRegistry, type SkillRecord } from "loopsoar-core/skill";

interface SkillsState {
  enabled: Record<string, boolean>;
}

export class SkillHost {
  private registry = new SkillRegistry();
  private stateFile: string;

  constructor(private dir: string) {
    this.stateFile = path.join(path.dirname(dir), "skills.json");
    this.scan();
  }

  private readState(): SkillsState {
    try {
      if (!fs.existsSync(this.stateFile)) return { enabled: {} };
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<SkillsState>;
      return { enabled: raw.enabled ?? {} };
    } catch {
      return { enabled: {} };
    }
  }

  private writeState(state: SkillsState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // 忽略：下次扫描按默认启用
    }
  }

  scan(): { installed: number; skipped: { dir: string; reason: string }[] } {
    const skipped: { dir: string; reason: string }[] = [];
    const state = this.readState();
    this.registry.clear();
    let installed = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const file = path.join(full, SKILL_FILE_NAME);
          if (!fs.existsSync(file)) continue;
          const raw = fs.readFileSync(file, "utf8");
          const bytes = new TextEncoder().encode(raw).length;
          if (bytes > SKILL_MAX_BYTES) {
            skipped.push({ dir: full, reason: `SKILL.md 超过 ${SKILL_MAX_BYTES} 字节` });
            continue;
          }
          const parsed = SkillRegistry.parseMarkdown(raw);
          this.registry.install(name, file, parsed.frontmatter, parsed.body, state.enabled[name] ?? true);
          if (!(name in state.enabled)) {
            state.enabled[name] = true;
          }
          installed += 1;
        } catch (err) {
          skipped.push({ dir: full, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      skipped.push({ dir: this.dir, reason: err instanceof Error ? err.message : String(err) });
    }
    this.writeState(state);
    return { installed, skipped };
  }

  list(): SkillRecord[] {
    return this.registry.list();
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | null {
    const item = this.registry.setEnabled(id, enabled);
    if (!item) return null;
    const state = this.readState();
    state.enabled[id] = enabled;
    this.writeState(state);
    return item;
  }

  dirPath(): string {
    return this.dir;
  }

  promptFor(userText: string): string {
    return this.registry.promptFor(userText);
  }
}
