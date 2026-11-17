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
          const stat = fs.statSync(file);
          const bytes = stat.size;
          let raw: string;
          let truncatedBytes = 0;
          if (bytes > SKILL_MAX_BYTES) {
            // 超长技能：只读取前 SKILL_MAX_BYTES 字节（按 UTF-8 安全截断），仍然安装并可用
            const fd = fs.openSync(file, "r");
            try {
              const buffer = Buffer.allocUnsafe(SKILL_MAX_BYTES);
              const read = fs.readSync(fd, buffer, 0, SKILL_MAX_BYTES, 0);
              raw = buffer.subarray(0, read).toString("utf8");
            } finally {
              fs.closeSync(fd);
            }
            truncatedBytes = bytes - SKILL_MAX_BYTES;
          } else {
            raw = fs.readFileSync(file, "utf8");
          }
          const parsed = SkillRegistry.parseMarkdown(raw, name);
          if (truncatedBytes > 0) {
            parsed.warnings.push(
              `SKILL.md 过大（${bytes} 字节），已读取前 ${SKILL_MAX_BYTES} 字节（${truncatedBytes} 字节未载入；可用 file_read 读取原文件）`,
            );
          }
          this.registry.install(name, file, parsed, undefined, state.enabled[name] ?? true);
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

  /**
   * 生成候选技能：写入 skills/<id>/SKILL.md，并在 skills.json 里默认禁用。
   * 候选不会进入提示词注入，直到用户在设置·技能里启用——避免 Agent 自动“学会”未审阅的流程。
   */
  createCandidate(input: {
    name: string;
    description: string;
    whenToUse?: string;
    body: string;
    tags?: string[];
  }): SkillRecord | null {
    const base =
      input.name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "candidate";
    let id = base;
    let suffix = 2;
    while (fs.existsSync(path.join(this.dir, id))) id = `${base}-${suffix++}`;
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = [
      "---",
      `name: ${JSON.stringify(input.name)}`,
      `description: ${JSON.stringify(input.description)}`,
      ...(input.whenToUse ? [`whenToUse: ${JSON.stringify(input.whenToUse)}`] : []),
      ...(input.tags && input.tags.length > 0
        ? ["tags:", ...input.tags.map((tag) => `  - ${JSON.stringify(tag)}`)]
        : []),
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, SKILL_FILE_NAME), `${frontmatter}${input.body.trim()}\n`, "utf8");
    const state = this.readState();
    state.enabled[id] = false;
    this.writeState(state);
    this.scan();
    return this.registry.list().find((item) => item.id === id) ?? null;
  }

  dirPath(): string {
    return this.dir;
  }

  promptFor(userText: string): string {
    return this.registry.promptFor(userText);
  }
}
