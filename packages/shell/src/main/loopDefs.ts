/**
 * Agent-Loop 定义发现（ADR-0010 L2 声明式 / L3 脚本）。
 *
 * 目录约定（全部落在 `<dataDir>/loops/`）：
 *   · L2 声明式：`loops/<any>.json` = { kind:"declarative", id?, name, description?, systemPromptAppend?,
 *                                     maxRounds?, maxToolCalls?, allowedTools?, temperature? }
 *                 id 缺省取文件名（小写）；kind 缺省即 declarative。
 *   · L3 脚本：  `loops/<id>/loop.json` = { kind:"script", name, script?, description? } + 同目录脚本文件
 *                id 取目录名；script 缺省 `loop.mjs`，必须位于该 loop 目录内（防穿越）。
 *
 * 为什么扫描放 shell 而不是 core：这是「文件系统策略层」，core 的 LoopRegistry 必须保持零 fs 依赖；
 * 而且坏文件要「跳过 + 记录 error」而不是让启动失败——安全模式的底线是内置 loop 永远能跑。
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BUDGET_HARD } from "loopsoar-contracts/security-policy";

/** 数据目录下的 loops 子目录名。 */
export const LOOPS_DIR_NAME = "loops";
/** L3 脚本 loop 的清单文件名。 */
export const LOOP_MANIFEST_FILE = "loop.json";
/** L3 脚本 loop 的默认脚本文件名。 */
export const DEFAULT_SCRIPT_FILE = "loop.mjs";
/** 首次创建 loops 目录时生成的 L2 模板文件名。 */
export const EXAMPLE_LOOP_FILE = "example.json";

/** loop id 约束（与 builtin `core-loop` 同形：小写字母数字与连字符，1~64 字符）。 */
export const LOOP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 声明式 loop 单条提示注入上限（防止把上下文一次塞爆）。 */
export const MAX_SYSTEM_PROMPT_APPEND = 20_000;

/**
 * L2 声明式 loop 的 zod 校验。
 * 预算字段上限取 contracts 的 BUDGET_HARD：声明只能「收紧」，runner 侧仍会与硬上限取 min。
 */
export const DeclarativeLoopSchema = z.object({
  kind: z.literal("declarative"),
  /** 缺省用文件名（小写）；显式给出时必须符合 LOOP_ID_RE。 */
  id: z.string().regex(LOOP_ID_RE, "id 仅允许小写字母/数字/连字符，1~64 字符").optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  /** 追加到本 loop 运行时的额外用户消息（volatile 段；不写进 stable 系统提示）。 */
  systemPromptAppend: z.string().max(MAX_SYSTEM_PROMPT_APPEND).optional(),
  /** 单次任务最大轮数（只能收紧，不能突破 BUDGET_HARD.maxRounds）。 */
  maxRounds: z.number().int().min(1).max(BUDGET_HARD.maxRounds).optional(),
  /** 单次任务最大工具调用次数（只能收紧，不能突破 BUDGET_HARD.maxToolCalls）。 */
  maxToolCalls: z.number().int().min(1).max(BUDGET_HARD.maxToolCalls).optional(),
  /** 工具白名单（省略/空 = 不限制）；白名单外的工具既不给模型也不允许执行。 */
  allowedTools: z.array(z.string().min(1).max(120)).max(200).optional(),
  /** 采样温度（0~2）。当前 LlmRequest 尚无 temperature 字段，先校验留存（见报告"风险"）。 */
  temperature: z.number().min(0).max(2).optional(),
});

export type DeclarativeLoopConfig = z.infer<typeof DeclarativeLoopSchema>;

/** L3 脚本 loop 清单的 zod 校验（script 缺省 loop.mjs）。 */
export const ScriptLoopManifestSchema = z.object({
  kind: z.literal("script"),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  /** 相对 loop 目录的脚本路径；必须位于 loop 目录内。 */
  script: z.string().min(1).max(200).optional(),
});

export type ScriptLoopManifest = z.infer<typeof ScriptLoopManifestSchema>;

/** 扫描结果中的一个可用 loop 定义。 */
export interface DeclarativeLoopDef {
  kind: "declarative";
  id: string;
  name: string;
  description?: string;
  /** 定义文件绝对路径（诊断/UI 展示用）。 */
  filePath: string;
  config: DeclarativeLoopConfig;
}

export interface ScriptLoopDef {
  kind: "script";
  id: string;
  name: string;
  description?: string;
  /** loop 目录绝对路径（worker 的 cwd 与脚本根）。 */
  loopDir: string;
  /** 清单文件绝对路径。 */
  filePath: string;
  /** 脚本相对路径（相对 loopDir，已校验不越界）。 */
  script: string;
  /** 脚本绝对路径（存在性已校验）。 */
  scriptPath: string;
}

export type LoopDef = DeclarativeLoopDef | ScriptLoopDef;

/** 坏定义记录：不阻断启动，列出「有文件但不可用」的原因。 */
export interface LoopDefError {
  /** 出问题的文件/目录绝对路径。 */
  path: string;
  /** 能推断出的 id（用于 UI 展示；可能缺失）。 */
  id?: string;
  error: string;
}

export interface LoopDefScanResult {
  loops: LoopDef[];
  errors: LoopDefError[];
  /** loops 目录绝对路径。 */
  dir: string;
  /** 本次是否新建了 example.json 模板。 */
  seededExample: boolean;
  /** 本次是否新建了 loops 目录。 */
  createdDir: boolean;
}

/** `<dataDir>/loops`。 */
export function loopsDirFor(dataDir: string): string {
  return path.join(dataDir, LOOPS_DIR_NAME);
}

/**
 * 首次创建 loops 目录时的 L2 模板（有效 JSON，可直接改 id/name 使用）。
 * 模板本身就是一个合法的声明式 loop，因此首次扫描后它会出现在列表里（可运行、可复制）。
 */
export const EXAMPLE_LOOP_TEMPLATE: Record<string, unknown> = {
  _readme:
    "L2 声明式 Agent-Loop 示例：复制本文件、改 id/name 即可新增一个 loop。systemPromptAppend 会作为额外的用户消息注入；maxRounds/maxToolCalls 只能收紧（不得突破安全硬上限）；allowedTools 省略表示不限制工具。",
  kind: "declarative",
  id: "example",
  name: "示例 Loop（可复制修改）",
  description: "演示 L2 声明式 loop：注入一段额外指令，并把单次任务限制为 12 轮 / 40 次工具调用。",
  systemPromptAppend: "【示例 Loop 指令】开始前先用一句话复述任务目标；不确定的信息必须调用工具核实，不要编造结果。",
  maxRounds: 12,
  maxToolCalls: 40,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issuesOf(error: z.ZodError<unknown>): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("；");
}

function readJsonFile(filePath: string, errors: LoopDefError[], id?: string): unknown | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    errors.push({ path: filePath, id, error: `读取失败：${errorMessage(err)}` });
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    errors.push({ path: filePath, id, error: `JSON 解析失败：${errorMessage(err)}` });
    return null;
  }
}

/** 解析一个 L2 声明式文件（`loops/*.json`）。 */
function parseDeclarativeLoop(
  filePath: string,
  fileName: string,
  errors: LoopDefError[],
): DeclarativeLoopDef | null {
  const fallbackId = fileName.replace(/\.json$/i, "").toLowerCase();
  const raw = readJsonFile(filePath, errors, fallbackId);
  if (raw === null) return null;
  if (isRecord(raw)) {
    // 显式 id 先做一次友好校验：zod regex 的报错路径不直观，而且这样能直接报出用户写的那个 id。
    if (raw.id !== undefined && (typeof raw.id !== "string" || !LOOP_ID_RE.test(raw.id))) {
      errors.push({
        path: filePath,
        id: fallbackId,
        error: `id "${String(raw.id)}" 不合法（要求 ${String(LOOP_ID_RE)}：小写字母/数字/连字符，1~64 字符）`,
      });
      return null;
    }
    // L2 位置写了 L3 声明：给出可执行的修正提示（而不是一句 Invalid literal value）。
    if (raw.kind !== undefined && raw.kind !== "declarative") {
      errors.push({
        path: filePath,
        id: fallbackId,
        error: `kind 必须是 "declarative"（L3 脚本 loop 应放在 <id>/loop.json）：${String(raw.kind)}`,
      });
      return null;
    }
  }
  // kind 缺省即 declarative（loops/*.json 一律按 L2 解释；显式写 script 已在上方拦掉）
  const normalized: unknown = { kind: "declarative", ...(isRecord(raw) ? raw : {}) };
  const parsed = DeclarativeLoopSchema.safeParse(normalized);
  if (!parsed.success) {
    errors.push({ path: filePath, id: fallbackId, error: `声明式 loop 校验失败：${issuesOf(parsed.error)}` });
    return null;
  }
  const id = parsed.data.id ?? fallbackId;
  if (!LOOP_ID_RE.test(id)) {
    errors.push({
      path: filePath,
      id,
      error: `id "${id}" 不合法（要求 ${String(LOOP_ID_RE)}：小写字母/数字/连字符，1~64 字符）`,
    });
    return null;
  }
  return {
    kind: "declarative",
    id,
    name: parsed.data.name,
    description: parsed.data.description,
    filePath,
    config: parsed.data,
  };
}

/** 绝对路径是否位于目录内（含自身）。 */
function isInsideDir(dir: string, target: string): boolean {
  const root = path.resolve(dir);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 解析一个 L3 脚本 loop 目录（`loops/<id>/loop.json`）。 */
function parseScriptLoop(loopDir: string, errors: LoopDefError[]): ScriptLoopDef | null {
  const id = path.basename(loopDir).toLowerCase();
  if (!LOOP_ID_RE.test(id)) {
    errors.push({
      path: loopDir,
      id,
      error: `目录名 "${path.basename(loopDir)}" 不是合法 loop id（要求小写字母/数字/连字符，1~64 字符）`,
    });
    return null;
  }
  const manifestPath = path.join(loopDir, LOOP_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    errors.push({ path: loopDir, id, error: `脚本 loop 目录缺少 ${LOOP_MANIFEST_FILE}` });
    return null;
  }
  const raw = readJsonFile(manifestPath, errors, id);
  if (raw === null) return null;
  const parsed = ScriptLoopManifestSchema.safeParse(raw);
  if (!parsed.success) {
    errors.push({ path: manifestPath, id, error: `脚本 loop 清单校验失败：${issuesOf(parsed.error)}` });
    return null;
  }
  const script = parsed.data.script ?? DEFAULT_SCRIPT_FILE;
  if (path.isAbsolute(script) || script.split(/[\\/]/).includes("..")) {
    errors.push({ path: manifestPath, id, error: `script 必须是 loop 目录内的相对路径：${script}` });
    return null;
  }
  const scriptPath = path.resolve(loopDir, script);
  if (!isInsideDir(loopDir, scriptPath)) {
    errors.push({ path: manifestPath, id, error: `script 越出 loop 目录：${script}` });
    return null;
  }
  if (!fs.existsSync(scriptPath)) {
    errors.push({ path: manifestPath, id, error: `脚本不存在：${script}` });
    return null;
  }
  return {
    kind: "script",
    id,
    name: parsed.data.name,
    description: parsed.data.description,
    loopDir,
    filePath: manifestPath,
    script,
    scriptPath,
  };
}

/** 首次创建 loops 目录时写入 example.json；已存在任何文件则不写。 */
export function ensureExampleLoop(dir: string): boolean {
  try {
    const target = path.join(dir, EXAMPLE_LOOP_FILE);
    if (fs.existsSync(target)) return false;
    const existing = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
    if (existing.length > 0) return false;
    fs.writeFileSync(target, `${JSON.stringify(EXAMPLE_LOOP_TEMPLATE, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描 `<dataDir>/loops`：返回可用定义 + 坏文件清单（绝不抛错、绝不因坏文件阻断启动）。
 * 目录不存在时自动创建；首次创建时写入 example.json 模板（可用 seedExample:false 关闭）。
 */
export function scanLoopDefs(
  dataDir: string,
  options: { seedExample?: boolean; dir?: string } = {},
): LoopDefScanResult {
  const dir = options.dir ? path.resolve(options.dir) : loopsDirFor(dataDir);
  const loops: LoopDef[] = [];
  const errors: LoopDefError[] = [];
  let seededExample = false;
  let createdDir = false;

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
    }
  } catch (err) {
    return {
      loops,
      errors: [{ path: dir, error: `无法创建 loops 目录：${errorMessage(err)}` }],
      dir,
      seededExample: false,
      createdDir: false,
    };
  }

  // 只在「目录是本次新建」时写模板：用户删掉 example.json 后不会每次 reload 又长回来。
  if (createdDir && options.seedExample !== false) seededExample = ensureExampleLoop(dir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      loops,
      errors: [{ path: dir, error: `读取 loops 目录失败：${errorMessage(err)}` }],
      dir,
      seededExample,
      createdDir,
    };
  }

  const seen = new Set<string>();
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    let def: LoopDef | null = null;
    if (entry.isDirectory()) {
      def = parseScriptLoop(abs, errors);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      def = parseDeclarativeLoop(abs, entry.name, errors);
    }
    if (!def) continue;
    if (seen.has(def.id)) {
      errors.push({ path: def.filePath, id: def.id, error: `loop id "${def.id}" 重复，已跳过该定义` });
      continue;
    }
    seen.add(def.id);
    loops.push(def);
  }

  // 扫描结果按 id 稳定排序：输出顺序不受文件系统/目录项顺序影响（UI 与测试可预期）。
  loops.sort((a, b) => a.id.localeCompare(b.id));

  return { loops, errors, dir, seededExample, createdDir };
}
