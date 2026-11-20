/**
 * Trace 记录：每个会话一份 JSONL，按工具调用/回合落盘，供 `trace_read` / `trace_summary` 回读。
 *
 * 为什么在壳层：trace 是运行痕迹，不是 Agent 语义；core 不该知道落盘格式。
 * 安全边界：参数只记录「键 + 截断后的标量」，敏感键（密码/令牌/Cookie 等）只记键名不记值；
 * 不记录工具完整输出（可能含页面内容/凭据），只记录成功与否与错误摘要。
 */
import fs from "node:fs";
import path from "node:path";
import { PRICING_NOTE } from "./pricing.js";

export interface TraceRecord {
  at: number;
  sessionId: string;
  kind: "tool" | "turn" | "error";
  tool?: string;
  ok?: boolean;
  ms?: number;
  error?: string;
  /** 参数摘要：`path=src/a.ts, content=<120 chars>`；敏感键值为 `<redacted>`。 */
  args?: string;
  rounds?: number;
  toolCalls?: number;
  tokens?: number;
  /** 回合使用的模型（用于成本展示）。 */
  model?: string;
  /** prompt / completion 拆分（上游提供时才有）。 */
  inputTokens?: number;
  outputTokens?: number;
  /** 本回合估算成本（USD；缺拆分或未知模型时不存在）。 */
  costUsd?: number;
  note?: string;
}

export interface TraceSummary {
  turns: number;
  toolCalls: number;
  failures: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** 窗口内所有回合的估算成本合计（USD）。 */
  costUsd: number;
  /** 窗口内最后一次 turn 的模型。 */
  model?: string;
  byTool: Array<{ tool: string; calls: number; failures: number; avgMs: number; maxMs: number }>;
  lastError?: string;
}

export interface TraceReport {
  sessionId: string;
  generatedAt: number;
  summary: TraceSummary;
  records: TraceRecord[];
  pricingNote: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 1500;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|cookie|authorization|credential|session[-_]?id/i;
const MAX_VALUE_CHARS = 80;

function safeSession(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "default";
}

function summarizeArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args).slice(0, 8)) {
    if (SENSITIVE_KEY.test(key)) {
      parts.push(`${key}=<redacted>`);
      continue;
    }
    let text: string;
    if (value === null || value === undefined) text = String(value);
    else if (typeof value === "string") text = value;
    else if (typeof value === "number" || typeof value === "boolean") text = String(value);
    else if (Array.isArray(value)) text = `[${value.length} 项]`;
    else text = "{…}";
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > MAX_VALUE_CHARS) text = `${text.slice(0, MAX_VALUE_CHARS)}…`;
    parts.push(`${key}=${text}`);
  }
  return parts.join(", ");
}

export class TraceStore {
  /** sessionId → 工具名 → 未配对的开始时间队列（循环内工具串行，队列防止并发会话互相覆盖）。 */
  private starts = new Map<string, Map<string, number[]>>();

  constructor(private readonly root: string) {}

  private file(sessionId: string): string {
    return path.join(this.root, `${safeSession(sessionId)}.jsonl`);
  }

  private append(record: TraceRecord): void {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const file = this.file(record.sessionId);
      // 轮转：超过上限时只保留尾部 KEEP_LINES 行，避免无限增长拖慢读取。
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) {
          const kept = fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-KEEP_LINES);
          fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
        }
      } catch {
        // 文件不存在：首次写入
      }
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // trace 落盘失败不影响主流程
    }
  }

  /** 工具开始：记下时间，供 observe 计算耗时。 */
  begin(sessionId: string, tool: string): void {
    const sid = sessionId || "default";
    const perSession = this.starts.get(sid) ?? new Map<string, number[]>();
    const queue = perSession.get(tool) ?? [];
    queue.push(Date.now());
    perSession.set(tool, queue);
    this.starts.set(sid, perSession);
  }

  /** 工具结束：配对最早的一次开始时间，落盘一条 tool 记录。 */
  observe(input: { sessionId: string; toolName: string; ok: boolean; error?: string; args?: Record<string, unknown> }): TraceRecord {
    const sid = input.sessionId || "default";
    const queue = this.starts.get(sid)?.get(input.toolName);
    const startedAt = queue?.shift();
    const argsSummary = summarizeArgs(input.args);
    const record: TraceRecord = {
      at: Date.now(),
      sessionId: sid,
      kind: "tool",
      tool: input.toolName,
      ok: input.ok,
      ...(startedAt ? { ms: Math.max(0, Date.now() - startedAt) } : {}),
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
      ...(argsSummary ? { args: argsSummary } : {}),
    };
    this.append(record);
    return record;
  }

  /** 回合结束：记录轮数/工具数/tokens/模型/成本，形成可读的纵向轨迹。 */
  turn(input: {
    sessionId: string;
    rounds?: number;
    toolCalls?: number;
    tokens?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    note?: string;
  }): void {
    this.append({
      at: Date.now(),
      sessionId: input.sessionId || "default",
      kind: "turn",
      ...(input.rounds !== undefined ? { rounds: input.rounds } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.note ? { note: input.note.slice(0, 200) } : {}),
    });
  }

  error(sessionId: string, message: string): void {
    this.append({
      at: Date.now(),
      sessionId: sessionId || "default",
      kind: "error",
      error: message.slice(0, 300),
    });
  }

  read(sessionId: string, limit = 20): TraceRecord[] {
    try {
      const lines = fs.readFileSync(this.file(sessionId || "default"), "utf8").trimEnd().split("\n");
      const out: TraceRecord[] = [];
      for (const line of lines.slice(-Math.max(1, Math.min(limit, 200)))) {
        try {
          out.push(JSON.parse(line) as TraceRecord);
        } catch {
          // 跳过损坏行
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 聚合：按工具统计次数/失败/耗时，并给出本会话总回合、工具调用、token 与成本。 */
  summary(sessionId: string, limit = 500): TraceSummary {
    const records = this.read(sessionId, limit);
    const byTool = new Map<string, { calls: number; failures: number; totalMs: number; maxMs: number }>();
    let turns = 0;
    let toolCalls = 0;
    let failures = 0;
    let tokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let model: string | undefined;
    let lastError: string | undefined;
    for (const record of records) {
      if (record.kind === "turn") {
        turns += 1;
        tokens += record.tokens ?? 0;
        inputTokens += record.inputTokens ?? 0;
        outputTokens += record.outputTokens ?? 0;
        costUsd += record.costUsd ?? 0;
        if (record.model) model = record.model;
      } else if (record.kind === "tool" && record.tool) {
        toolCalls += 1;
        if (record.ok === false) failures += 1;
        if (record.error) lastError = `${record.tool}: ${record.error}`;
        const stat = byTool.get(record.tool) ?? { calls: 0, failures: 0, totalMs: 0, maxMs: 0 };
        stat.calls += 1;
        if (record.ok === false) stat.failures += 1;
        stat.totalMs += record.ms ?? 0;
        stat.maxMs = Math.max(stat.maxMs, record.ms ?? 0);
        byTool.set(record.tool, stat);
      } else if (record.kind === "error" && record.error) {
        lastError = record.error;
      }
    }
    return {
      turns,
      toolCalls,
      failures,
      tokens,
      inputTokens,
      outputTokens,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      ...(model ? { model } : {}),
      byTool: [...byTool.entries()]
        .map(([tool, stat]) => ({
          tool,
          calls: stat.calls,
          failures: stat.failures,
          avgMs: Math.round(stat.totalMs / Math.max(1, stat.calls)),
          maxMs: stat.maxMs,
        }))
        .sort((a, b) => b.calls - a.calls),
      ...(lastError ? { lastError } : {}),
    };
  }

  /** 面板一次性读取：聚合 + 最近记录 + 定价说明。 */
  report(sessionId: string, limit = 50): TraceReport {
    const sid = sessionId || "default";
    return {
      sessionId: sid,
      generatedAt: Date.now(),
      summary: this.summary(sid),
      records: this.read(sid, Math.max(1, Math.min(limit, 200))),
      pricingNote: PRICING_NOTE,
    };
  }
}
