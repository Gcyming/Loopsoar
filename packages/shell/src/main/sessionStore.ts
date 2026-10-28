/**
 * 会话持久化（壳层）：把每次对话追加到 <dataDir>/sessions/last.json。
 * 为什么只存最近一份：v1 的「恢复上次会话」是单会话恢复；多会话列表属于后续版本（接口不变：load/append）。
 * 结构：{ sessionId, updatedAt, messages: [{role, text, ts}] }，最多保留 200 条。
 */
import fs from "node:fs";
import path from "node:path";

export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface PersistedSession {
  sessionId: string;
  updatedAt: number;
  messages: PersistedMessage[];
}

const MAX_MESSAGES = 200;

export class SessionStore {
  constructor(private filePath: string) {}

  load(): PersistedSession | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedSession;
      if (!parsed || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(session: PersistedSession): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const trimmed: PersistedSession = {
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(trimmed, null, 2), "utf8");
  }

  /** 追加一轮对话（用户消息 + 助手最终答复）。 */
  append(sessionId: string, userMessage: string, assistantReply: string): PersistedSession {
    const current = this.load();
    const base: PersistedSession =
      current && current.sessionId === sessionId
        ? current
        : { sessionId, updatedAt: Date.now(), messages: [] };
    base.messages.push({ role: "user", text: userMessage, ts: Date.now() });
    if (assistantReply.trim()) {
      base.messages.push({ role: "assistant", text: assistantReply, ts: Date.now() });
    }
    base.updatedAt = Date.now();
    this.save(base);
    return base;
  }
}
