/**
 * 会话持久化（壳层，多会话）：<dataDir>/sessions/
 *   index.json            { currentId, items: [{ id, title, updatedAt, preview, messageCount }] }
 *   <sessionId>.json      { sessionId, updatedAt, messages: [{role, text, ts}] }
 *
 * 兼容旧版：若存在 last.json（单会话时代），首次加载自动迁移为一条会话。
 * 最多保留 200 条消息；列表按 updatedAt 倒序。
 *
 * 安全：所有「sessionId → 文件路径」的拼接都必须先过 sanitizeSessionId（见 sessionId.ts）。
 * 非法 ID 一律 fail-closed（get→null / remove→false / save→抛可读错误，绝不落盘），
 * 防止 IPC 入参里的 `../` 把会话文件写到数据目录之外。
 */
import fs from "node:fs";
import path from "node:path";
import type { PersistedBrowserState } from "./browserSessionState.js";
import { requireSessionId, sanitizeSessionId } from "./sessionId.js";

export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** 助手消息的交错时间线（思考/工具/规划/播报/引导）；用户消息无此字段。 */
  timeline?: unknown[];
  /** 生成本条回复的供应商/模型（用于悬停显示历史真实模型，而不是当前选择）。 */
  provider?: string;
  model?: string;
  /**
   * 该条是「上下文压缩摘要」（/compact apply 写入的合成消息，不是模型真实回复）。
   * 为什么落盘要带标记：UI/后续压缩都要能把它和真实消息区分开，避免被再次压缩或误当模型输出。
   */
  compacted?: boolean;
}

export interface PersistedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  createdAt: number;
}

export interface PersistedSession {
  sessionId: string;
  updatedAt: number;
  messages: PersistedMessage[];
  /** 该会话最后打开的网页（会话即"文件夹"；重启后恢复左侧页面）。 */
  browser?: PersistedBrowserState;
  /** 会话归属的工作区（WorkpsaceStore 的 id）。 */
  workspaceId?: string | null;
  /** 该会话的隔离 git worktree；存在时 Agent 的工作根目录取它。 */
  worktree?: PersistedWorktree | null;
  /**
   * 会话级「浏览器控制」开关（第二阶段 · 功能1）：开启后 Agent 才看得见 browser_* 工具。
   * 缺省（旧会话 / 新会话）= 关闭（fail-closed）；非布尔脏值在读取/写入时一律丢弃。
   */
  browserControl?: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
  messageCount: number;
  /** 会话归属的工作区 id（旧会话可能没有）。 */
  workspaceId?: string | null;
  /** 会话级「浏览器控制」开关（缺省 = 关闭）；列表/当前会话查询据此给 UI 水合初值。 */
  browserControl?: boolean;
}

interface SessionIndex {
  currentId: string | null;
  items: SessionMeta[];
}

const MAX_MESSAGES = 200;
const MAX_SESSIONS = 100;

/**
 * 索引条目净化：`browserControl` 只认布尔。
 * 旧版本写的索引 / 手工编辑出的脏值（"false"、1、null…）若留着，
 * UI 与工具面会各按各的真值语义理解——这里统一丢弃，缺省即「关闭」。
 */
function sanitizeMeta(item: SessionMeta): SessionMeta {
  if (item && typeof item === "object" && item.browserControl !== undefined && typeof item.browserControl !== "boolean") {
    delete item.browserControl;
  }
  return item;
}

/** 会话文件净化：同 sanitizeMeta（缺省 = 关闭 = fail-closed）。 */
function sanitizeSession(data: PersistedSession): PersistedSession {
  if (data.browserControl !== undefined && typeof data.browserControl !== "boolean") {
    delete data.browserControl;
  }
  return data;
}

export class SessionStore {
  private dir: string;
  private indexFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = path.join(dir, "index.json");
    this.ensureDirs();
    this.migrateLegacy();
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(value, null, 2);
    // 原子写：先写临时文件再 rename 替换。普通 writeFileSync 在进程被强杀/断电时会留下
    // 半截 JSON，readJson 解析失败返回 null → 整个会话历史「凭空消失」；rename 保证
    // 文件要么是旧完整版、要么是新完整版。
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能不存在：忽略
      }
      // 极端环境（目录权限/文件被占用）：退回直接写，至少不阻断正常功能
      fs.writeFileSync(file, payload, "utf8");
    }
  }

  private index(): SessionIndex {
    const raw = this.readJson<Partial<SessionIndex>>(this.indexFile);
    if (raw && Array.isArray(raw.items)) {
      return {
        currentId: raw.currentId && raw.items.some((i) => i.id === raw.currentId) ? raw.currentId : (raw.items[0]?.id ?? null),
        items: raw.items.map((item) => sanitizeMeta(item)),
      };
    }
    return { currentId: null, items: [] };
  }

  private saveIndex(index: SessionIndex): void {
    const items = index.items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
    this.writeJson(this.indexFile, { currentId: index.currentId, items });
  }

  /**
   * 会话文件路径（唯一拼接点）：非法 ID 返回 null，调用方据此 fail-closed。
   * 为什么返回 null 而不是抛：读路径（get/getBrowserState/getWorktree…）在 IPC 层
   * 本就用 null 表达「不存在」，不一致会让调用方误判为「文件损坏」。
   */
  private sessionFile(id: string | null | undefined): string | null {
    const safe = sanitizeSessionId(id);
    if (!safe) return null;
    return path.join(this.dir, `${safe}.json`);
  }

  /** 唯一的「会话文件 → 对象」读取入口：读出来先净化字段。 */
  private readSession(file: string): PersistedSession | null {
    const data = this.readJson<PersistedSession>(file);
    return data ? sanitizeSession(data) : null;
  }

  /** 旧版 last.json → 会话文件 + 索引。 */
  private migrateLegacy(): void {
    if (fs.existsSync(this.indexFile)) return;
    const legacy = this.readJson<PersistedSession>(path.join(this.dir, "last.json"));
    if (!legacy || !Array.isArray(legacy.messages) || legacy.messages.length === 0) return;
    // 旧数据里的 sessionId 不可信（可能来自手工编辑/更早版本），非法则换新 ID，绝不拿它拼路径。
    const id = sanitizeSessionId(legacy.sessionId) || `sess-${Date.now()}`;
    const file = this.sessionFile(id);
    if (!file) return;
    this.writeJson(file, { ...legacy, sessionId: id });
    this.writeJson(this.indexFile, {
      currentId: id,
      items: [this.metaOf(id, legacy.messages, legacy.updatedAt)],
    });
  }

  private metaOf(
    id: string,
    messages: PersistedMessage[],
    updatedAt: number,
    workspaceId?: string | null,
    browserControl?: boolean,
  ): SessionMeta {
    const firstUser = messages.find((m) => m.role === "user")?.text ?? "新会话";
    const last = messages[messages.length - 1]?.text ?? "";
    return {
      id,
      title: firstUser.replace(/\s+/g, " ").slice(0, 40) || "新会话",
      updatedAt,
      preview: last.replace(/\s+/g, " ").slice(0, 80),
      messageCount: messages.length,
      ...(workspaceId ? { workspaceId } : {}),
      ...(typeof browserControl === "boolean" ? { browserControl } : {}),
    };
  }

  /** 保存某会话的浏览器标签快照（不触发 updatedAt/列表元信息变化）。 */
  saveBrowserState(sessionId: string, state: PersistedBrowserState): boolean {
    const file = this.sessionFile(sessionId);
    if (!file) return false;
    const data = this.readSession(file);
    if (!data) return false;
    data.browser = state.tabs.length > 0 ? state : undefined;
    this.writeJson(file, data);
    return true;
  }

  /** 读取某会话的浏览器标签快照（旧文件无此字段时返回 null）。 */
  getBrowserState(sessionId: string): PersistedBrowserState | null {
    return this.get(sessionId)?.browser ?? null;
  }

  /**
   * 目标会话 id：显式传入时只用它（非法即拒绝，不回退到当前会话——否则会把数据写到错误的会话）；
   * 未传入时才取 currentId。
   */
  private targetId(sessionId: string | null | undefined): string | null {
    if (sessionId === null || sessionId === undefined) return sanitizeSessionId(this.currentId());
    return sanitizeSessionId(sessionId);
  }

  /** 把时间线挂到最后一条助手消息（对话完成后由 UI 上报；失败静默不影响对话）。 */
  attachTimeline(sessionId: string | null, timeline: unknown[]): boolean {
    const id = this.targetId(sessionId);
    if (!id) return false;
    const file = this.sessionFile(id);
    if (!file) return false;
    const data = this.readSession(file);
    if (!data) return false;
    for (let i = data.messages.length - 1; i >= 0; i -= 1) {
      if (data.messages[i].role === "assistant") {
        data.messages[i] = { ...data.messages[i], timeline };
        this.writeJson(file, data);
        return true;
      }
    }
    return false;
  }

  /** 截断到第 keepCount 条消息（保留 [0, keepCount)），用于消息回滚；返回截断后的会话。 */
  truncate(sessionId: string | null, keepCount: number): PersistedSession | null {
    const id = this.targetId(sessionId);
    if (!id) return null;
    const file = this.sessionFile(id);
    if (!file) return null;
    const data = this.readSession(file);
    if (!data) return null;
    const keep = Math.max(0, Math.min(Math.floor(keepCount), data.messages.length));
    data.messages = data.messages.slice(0, keep);
    data.updatedAt = Date.now();
    this.writeJson(file, data);
    const index = this.index();
    const meta = index.items.find((i) => i.id === id);
    if (meta) {
      const last = data.messages[data.messages.length - 1];
      meta.messageCount = data.messages.length;
      meta.preview = last ? last.text.slice(0, 80) : "";
      meta.updatedAt = data.updatedAt;
      this.saveIndex(index);
    }
    return data;
  }

  /**
   * 用给定消息「整体替换」某会话的历史（/compact apply 的唯一落盘入口）。
   *
   * 与 truncate 的区别：truncate 只按条数截断前缀（回滚语义），replaceMessages
   * 接受调用方算好的完整消息数组（压缩摘要 + 保留的最近消息），并同步索引元信息。
   * 语义约束：
   *   - 只做替换 + 元信息同步；压缩判断全部在 core/contextCompress，壳层不重复实现；
   *   - 会话不存在 / ID 非法 → null（fail-closed），绝不新建会话文件；
   *   - 超过 MAX_MESSAGES 时保留最后 MAX_MESSAGES 条（与 save 一致，防空转膨胀）；
   *   - 调用方负责传入「已保留字段」的消息（timeline/provider/model 不会被改写）。
   */
  replaceMessages(
    sessionId: string | null | undefined,
    messages: PersistedMessage[],
  ): PersistedSession | null {
    const id = this.targetId(sessionId);
    if (!id) return null;
    const file = this.sessionFile(id);
    if (!file) return null;
    const data = this.readSession(file);
    if (!data) return null;
    const next = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
    data.messages = next;
    data.updatedAt = Date.now();
    this.writeJson(file, data);
    const index = this.index();
    const meta = index.items.find((i) => i.id === id);
    if (meta) {
      const last = next[next.length - 1];
      meta.messageCount = next.length;
      meta.preview = last ? last.text.replace(/\s+/g, " ").slice(0, 80) : "";
      meta.updatedAt = data.updatedAt;
      this.saveIndex(index);
    }
    return data;
  }

  list(): SessionMeta[] {
    return this.index().items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  currentId(): string | null {
    return this.index().currentId;
  }

  get(id: string): PersistedSession | null {
    const file = this.sessionFile(id);
    return file ? this.readSession(file) : null;
  }

  /**
   * 读取指定会话的消息（按会话取历史，供 ChatService.getHistory 用）。
   * 非法 ID / 会话不存在都返回 null；调用方按「无历史」处理。
   */
  loadMessages(sessionId: string): PersistedMessage[] | null {
    return this.get(sessionId)?.messages ?? null;
  }

  /** 兼容旧接口：当前会话。 */
  load(): PersistedSession | null {
    const id = this.currentId();
    return id ? this.get(id) : null;
  }

  save(session: PersistedSession): PersistedSession {
    // 写路径非法 ID 必须显式失败：静默丢弃会让 UI 以为「已保存」而下次启动丢历史。
    const safeId = requireSessionId(session.sessionId);
    const file = this.sessionFile(safeId);
    if (!file) throw new Error(`[错误] 非法会话 ID：${safeId}`);
    // 写入同样净化：调用方可能把外部读来的对象整体回写，脏值不该被固化进磁盘。
    const trimmed: PersistedSession = sanitizeSession({
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES),
    });
    this.writeJson(file, trimmed);
    const index = this.index();
    const meta = this.metaOf(safeId, trimmed.messages, trimmed.updatedAt, trimmed.workspaceId, trimmed.browserControl);
    const at = index.items.findIndex((i) => i.id === safeId);
    if (at >= 0) index.items[at] = meta;
    else index.items.push(meta);
    index.currentId = index.currentId ?? safeId;
    this.saveIndex(index);
    return trimmed;
  }

  newSession(workspaceId?: string | null): PersistedSession {
    const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const file = this.sessionFile(id);
    if (!file) throw new Error("[错误] 内部生成的会话 ID 非法");
    const session: PersistedSession = {
      sessionId: id,
      updatedAt: Date.now(),
      messages: [],
      ...(workspaceId ? { workspaceId } : {}),
    };
    this.writeJson(file, session);
    const index = this.index();
    index.items.push(this.metaOf(id, [], Date.now(), workspaceId));
    index.currentId = id;
    this.saveIndex(index);
    return session;
  }

  /** 会话归属工作区（旧会话可补绑）。 */
  setWorkspaceId(sessionId: string, workspaceId: string | null): boolean {
    const file = this.sessionFile(sessionId);
    if (!file) return false;
    const data = this.readSession(file);
    if (!data) return false;
    data.workspaceId = workspaceId;
    this.writeJson(file, data);
    const index = this.index();
    const meta = index.items.find((item) => item.id === sessionId);
    if (meta) {
      if (workspaceId) meta.workspaceId = workspaceId;
      else delete meta.workspaceId;
      this.saveIndex(index);
    }
    return true;
  }

  getWorktree(sessionId: string): PersistedWorktree | null {
    return this.get(sessionId)?.worktree ?? null;
  }

  setWorktree(sessionId: string, worktree: PersistedWorktree | null): boolean {
    const file = this.sessionFile(sessionId);
    if (!file) return false;
    const data = this.readSession(file);
    if (!data) return false;
    data.worktree = worktree;
    this.writeJson(file, data);
    return true;
  }

  /**
   * 会话级「浏览器控制」开关（第二阶段 · 功能1）。
   *
   * 为什么同时写索引：UI 的会话列表/当前会话查询要拿初值水合；只写会话文件会让
   * 「切走再切回」的开关状态回退成关闭，用户以为设置丢了。
   * 非法 ID / 会话不存在 → false（fail-closed，绝不新建会话文件）。
   */
  setBrowserControl(sessionId: string, enabled: boolean): boolean {
    const file = this.sessionFile(sessionId);
    if (!file) return false;
    const data = this.readSession(file);
    if (!data) return false;
    data.browserControl = enabled;
    this.writeJson(file, data);
    const index = this.index();
    const meta = index.items.find((item) => item.id === sessionId);
    if (meta) {
      meta.browserControl = enabled;
      this.saveIndex(index);
    }
    return true;
  }

  switchTo(id: string): boolean {
    // 索引只由本模块维护，理论上 id 一定合法；仍校验一次（索引文件可被手工编辑）。
    if (!sanitizeSessionId(id)) return false;
    const index = this.index();
    if (!index.items.some((i) => i.id === id)) return false;
    index.currentId = id;
    this.saveIndex(index);
    return true;
  }

  /** 追加一轮对话（用户消息 + 助手最终答复）。 */
  append(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    meta?: { provider?: string; model?: string },
  ): PersistedSession {
    const current = this.get(sessionId);
    const base: PersistedSession = current ?? { sessionId, updatedAt: Date.now(), messages: [] };
    base.messages.push({ role: "user", text: userMessage, ts: Date.now() });
    if (assistantReply.trim()) {
      base.messages.push({
        role: "assistant",
        text: assistantReply,
        ts: Date.now(),
        ...(meta?.provider ? { provider: meta.provider } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
      });
    }
    base.updatedAt = Date.now();
    return this.save(base);
  }

  /**
   * 追加一条「只含助手已生成正文」的消息（应用退出 / 异常中断时保住已产出内容）。
   * 与 append 的区别：不再补 user 消息（该轮的用户消息已在会话里或不需要），
   * 防止退出瞬间已生成的正文丢失 —— 重启后用户看到「回复凭空少了后半段」。
   */
  appendAssistantPartial(sessionId: string, text: string): boolean {
    const id = this.targetId(sessionId);
    if (!id) return false;
    if (!text.trim()) return false;
    const current = this.get(id);
    const base: PersistedSession = current ?? { sessionId: id, updatedAt: Date.now(), messages: [] };
    base.messages.push({ role: "assistant", text, ts: Date.now() });
    base.updatedAt = Date.now();
    this.save(base);
    return true;
  }

  remove(id: string): boolean {
    const file = this.sessionFile(id);
    if (!file) return false;
    const index = this.index();
    const exists = index.items.some((i) => i.id === id);
    if (!exists) return false;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      return false;
    }
    index.items = index.items.filter((i) => i.id !== id);
    if (index.currentId === id) index.currentId = index.items[0]?.id ?? null;
    this.saveIndex(index);
    return true;
  }
}
