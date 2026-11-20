/**
 * L2/L3 Agent-Loop 定义扫描（shell/loopDefs.ts）：
 * 目录约定、zod 校验、坏文件跳过不阻断、首次模板生成、脚本路径穿越防护。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SCRIPT_FILE,
  EXAMPLE_LOOP_FILE,
  EXAMPLE_LOOP_TEMPLATE,
  LOOP_ID_RE,
  RESERVED_LOOP_IDS,
  deleteDeclarativeLoop,
  ensureExampleLoop,
  loopsDirFor,
  saveDeclarativeLoop,
  scanLoopDefs,
  type DeclarativeLoopDef,
  type ScriptLoopDef,
} from "../../packages/shell/src/main/loopDefs.ts";

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-loopdefs-"));
  createdDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

/** 预建 loops 目录（避免首次扫描顺带生成 example.json 干扰断言）。 */
function prepareLoopsDir(dataDir: string): string {
  const dir = loopsDirFor(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loopDefs：首次扫描与模板", () => {
  it("数据目录为空：创建 loops 目录 + example.json 模板，模板本身是合法声明式 loop", () => {
    const dataDir = tempDir();

    const result = scanLoopDefs(dataDir);

    expect(result.createdDir).toBe(true);
    expect(result.seededExample).toBe(true);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(loopsDirFor(dataDir), EXAMPLE_LOOP_FILE))).toBe(true);

    const example = result.loops.find((loop) => loop.id === "example");
    expect(example?.kind).toBe("declarative");
    if (example?.kind === "declarative") {
      expect(example.name).toBe(String(EXAMPLE_LOOP_TEMPLATE.name));
      expect(example.config.maxRounds).toBe(12);
      expect(example.config.systemPromptAppend).toBeTruthy();
    }
  });

  it("目录已存在时不重复生成模板；ensureExampleLoop 幂等且不覆盖已有文件", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    const result = scanLoopDefs(dataDir);
    expect(result.createdDir).toBe(false);
    expect(result.seededExample).toBe(false);
    expect(fs.existsSync(path.join(dir, EXAMPLE_LOOP_FILE))).toBe(false);

    // 空目录但已存在：ensureExampleLoop 可手工补模板，第二次调用不覆盖
    expect(ensureExampleLoop(dir)).toBe(true);
    const content = fs.readFileSync(path.join(dir, EXAMPLE_LOOP_FILE), "utf8");
    fs.writeFileSync(path.join(dir, EXAMPLE_LOOP_FILE), "{}", "utf8");
    expect(ensureExampleLoop(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, EXAMPLE_LOOP_FILE), "utf8")).toBe("{}");
    expect(content.length).toBeGreaterThan(0);
  });

  it("id 规则：小写字母/数字/连字符，1~64 字符", () => {
    expect(LOOP_ID_RE.test("example")).toBe(true);
    expect(LOOP_ID_RE.test("my-loop-2")).toBe(true);
    expect(LOOP_ID_RE.test("Example")).toBe(false);
    expect(LOOP_ID_RE.test("-bad")).toBe(false);
    expect(LOOP_ID_RE.test("")).toBe(false);
    expect(LOOP_ID_RE.test("a".repeat(65))).toBe(false);
    expect(EXAMPLE_LOOP_TEMPLATE.id).toBe("example");
  });
});

describe("loopDefs：L2 声明式", () => {
  it("合法文件被解析（kind 缺省 declarative，id 缺省取文件名）", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    writeJson(path.join(dir, "my-loop.json"), {
      name: "我的循环",
      description: "只读分析",
      systemPromptAppend: "先做计划再动手",
      maxRounds: 7,
      maxToolCalls: 20,
      allowedTools: ["file_read", "browser_snapshot"],
    });

    const result = scanLoopDefs(dataDir);

    expect(result.errors).toEqual([]);
    expect(result.loops.map((loop) => loop.id)).toEqual(["my-loop"]);
    const def = result.loops[0] as DeclarativeLoopDef;
    expect(def.kind).toBe("declarative");
    expect(def.config.kind).toBe("declarative");
    expect(def.name).toBe("我的循环");
    expect(def.description).toBe("只读分析");
    expect(def.config.maxRounds).toBe(7);
    expect(def.config.maxToolCalls).toBe(20);
    expect(def.config.allowedTools).toEqual(["file_read", "browser_snapshot"]);
  });

  it("显式 id 覆盖文件名，且必须符合 id 规则", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    writeJson(path.join(dir, "whatever.json"), { id: "explicit-id", name: "显式 id" });
    writeJson(path.join(dir, "bad-id.json"), { id: "Bad ID", name: "非法 id" });

    const result = scanLoopDefs(dataDir);

    expect(result.loops.map((loop) => loop.id)).toEqual(["explicit-id"]);
    expect(result.errors.some((item) => /id "Bad ID" 不合法/.test(item.error))).toBe(true);
  });
});

describe("loopDefs：坏文件跳过（不抛错、不阻断）", () => {
  it("坏 JSON / 校验失败 / 预算越界 / 重复 id 全部记录 error，好 loop 仍可用", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    writeJson(path.join(dir, "good.json"), { name: "好的" });
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf8");
    writeJson(path.join(dir, "empty-name.json"), { name: "" });
    writeJson(path.join(dir, "too-big.json"), { name: "越界", maxRounds: 999_999 });
    writeJson(path.join(dir, "dup-a.json"), { id: "same", name: "A" });
    writeJson(path.join(dir, "dup-b.json"), { id: "same", name: "B" });

    expect(() => scanLoopDefs(dataDir)).not.toThrow();
    const result = scanLoopDefs(dataDir);

    expect(result.loops.map((loop) => loop.id)).toEqual(["good", "same"]);
    // 说明：scanLoopDefs 按 id 稳定排序（与目录文件名顺序无关）——good < same。
    // 文件名为 dup-a/dup-b 的两份定义都声明 id "same"：先命中者注册、后者记「重复」错误。
    const messages = result.errors.map((item) => item.error).join("\n");
    expect(messages).toMatch(/JSON 解析失败/);
    expect(messages).toMatch(/校验失败/);
    expect(messages).toMatch(/重复/);
    // 坏文件带 id 提示（UI 能看出是哪个文件坏了）
    expect(result.errors.every((item) => typeof item.path === "string" && item.path.length > 0)).toBe(true);
  });
});

describe("loopDefs：L3 脚本", () => {
  it("<id>/loop.json 解析为 script，脚本缺省 loop.mjs", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    const loopDir = path.join(dir, "scripty");
    writeJson(path.join(loopDir, "loop.json"), { kind: "script", name: "脚本循环", description: "RPC 编排" });
    fs.writeFileSync(path.join(loopDir, "loop.mjs"), "export async function run() {}\n", "utf8");

    const result = scanLoopDefs(dataDir);

    expect(result.errors).toEqual([]);
    const def = result.loops.find((loop) => loop.id === "scripty") as ScriptLoopDef;
    expect(def.kind).toBe("script");
    expect(def.script).toBe(DEFAULT_SCRIPT_FILE);
    expect(def.scriptPath).toBe(path.join(loopDir, "loop.mjs"));
    expect(def.loopDir).toBe(loopDir);
  });

  it("清单可指定子目录脚本；脚本越界 / 缺失 / 清单缺失 / kind 不符 → error", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);

    // 合法：script 指向子目录
    writeJson(path.join(dir, "nested", "loop.json"), { kind: "script", name: "嵌套脚本", script: "scripts/run.mjs" });
    fs.mkdirSync(path.join(dir, "nested", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "scripts", "run.mjs"), "export async function run() {}\n", "utf8");

    // 越界
    writeJson(path.join(dir, "escape", "loop.json"), { kind: "script", name: "越界", script: "../evil.mjs" });
    fs.writeFileSync(path.join(dir, "escape", "loop.mjs"), "", "utf8");

    // 缺失脚本
    writeJson(path.join(dir, "missing", "loop.json"), { kind: "script", name: "缺脚本", script: "nope.mjs" });

    // 缺清单
    fs.mkdirSync(path.join(dir, "no-manifest"), { recursive: true });

    // 文件里写 script（L2 位置声明 L3）
    writeJson(path.join(dir, "wrong-kind.json"), { kind: "script", name: "位置错" });

    const result = scanLoopDefs(dataDir);

    expect(result.loops.map((loop) => loop.id)).toEqual(["nested"]);
    const nested = result.loops[0] as ScriptLoopDef;
    expect(nested.script).toBe("scripts/run.mjs");
    const messages = result.errors.map((item) => item.error).join("\n");
    expect(messages).toMatch(/相对路径/);
    expect(messages).toMatch(/脚本不存在/);
    expect(messages).toMatch(/缺少 loop.json/);
    // *.json 里写 kind:"script"（L3 位置错误）→ 给出可执行的修正提示
    expect(messages).toMatch(/kind 必须是 "declarative"/);
  });
});

describe("自定义 loop 编译 / 删除（设置页链路）", () => {
  it("saveDeclarativeLoop：校验 → 原子写 loops/<id>.json → 可被扫描并保留阶段开关", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);

    const saved = saveDeclarativeLoop(dataDir, {
      kind: "declarative",
      id: "web-research",
      name: "网页调研",
      description: "先检索再整理",
      maxRounds: 6,
      maxToolCalls: 24,
      stages: [
        { id: "plan", enabled: true },
        { id: "research", enabled: true },
        { id: "browse", enabled: false },
        { id: "interact", enabled: false },
        { id: "workspace", enabled: true },
        { id: "delegate", enabled: false },
      ],
      allowedTools: ["web_search", "todo_write"],
    });

    expect(saved.filePath).toBe(path.join(dir, "web-research.json"));
    expect(saved.config.id).toBe("web-research");
    const raw = JSON.parse(fs.readFileSync(saved.filePath, "utf8")) as Record<string, unknown>;
    expect(raw.kind).toBe("declarative");
    expect(raw.stages).toEqual((saved.config.stages ?? []));

    const scanned = scanLoopDefs(dataDir);
    const def = scanned.loops.find((loop) => loop.id === "web-research");
    expect(def?.kind).toBe("declarative");
    if (def?.kind === "declarative") {
      expect(def.config.stages?.find((stage) => stage.id === "browse")?.enabled).toBe(false);
      expect(def.config.allowedTools).toEqual(["web_search", "todo_write"]);
    }
  });

  it("saveDeclarativeLoop：非法 id/保留 id/重复脚本目录都拒绝，且不写半截文件", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    fs.mkdirSync(path.join(dir, "taken"), { recursive: true });

    expect(() => saveDeclarativeLoop(dataDir, { id: "../escape", name: "坏 id" })).toThrow(/id/);
    expect(() => saveDeclarativeLoop(dataDir, { id: RESERVED_LOOP_IDS[0], name: "内置" })).toThrow(/保留名/);
    expect(() => saveDeclarativeLoop(dataDir, { id: "taken", name: "冲突" })).toThrow(/脚本 loop 目录/);
    expect(fs.existsSync(path.join(dir, "taken.json"))).toBe(false);
  });

  it("deleteDeclarativeLoop：只删除 JSON；脚本目录与未知 id 拒绝", () => {
    const dataDir = tempDir();
    const dir = prepareLoopsDir(dataDir);
    saveDeclarativeLoop(dataDir, { id: "temp-loop", name: "临时" });
    const target = path.join(dir, "temp-loop.json");
    expect(fs.existsSync(target)).toBe(true);

    expect(deleteDeclarativeLoop(dataDir, "temp-loop").filePath).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(() => deleteDeclarativeLoop(dataDir, "temp-loop")).toThrow(/不存在/);

    fs.mkdirSync(path.join(dir, "script-loop"), { recursive: true });
    expect(() => deleteDeclarativeLoop(dataDir, "script-loop")).toThrow(/不存在/);
    expect(fs.existsSync(path.join(dir, "script-loop"))).toBe(true);
  });
});
