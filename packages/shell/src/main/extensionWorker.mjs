/**
 * 扩展 worker 进程（由 ExtensionRuntime spawn；不 import electron）。
 * 用法：node extensionWorker.mjs <extensionDir> <mainRel>
 * 协议：stdin/stdout 行分隔 JSON（见 packages/core/src/extensionWorker.ts，协议 v2）。
 *
 * 扩展模块契约（ESM）：
 *   export async function activate(api) {
 *     api.registerTool({ name, description, parameters, permissions, execute });
 *     api.on("turn.start", async (payload) => ({ ... }));       // 需 manifest.events 声明
 *     api.on("tool.before", async (payload) => ({ allow: true }));
 *     api.onViewMessage("dashboard", async (message) => ({ ... }));
 *   }
 *   或 export default activate
 * 每个工具的 execute(args, ctx) 可返回 string 或 { ok, content, error }。
 *
 * 安全边界：本进程只是「隔离」不是「信任边界」——权限/确认/沙箱仍由主进程裁定；
 * worker 不能访问主进程内存，但同用户权限下仍可读写文件（除非 manifest.isolation 启用）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const [, , extensionDir, mainRel] = process.argv;
const PROTOCOL = 2;

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // stdout 已关闭：worker 即将退出
  }
}

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(extensionDir, "loopsoar.extension.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const manifest = readManifest();
const declaredEvents = Array.isArray(manifest.events) ? manifest.events.filter((item) => typeof item === "string") : [];
const tools = new Map();
const eventHandlers = new Map();
const viewHandlers = new Map();

const api = {
  /** 宿主 API 版本（扩展可据此分支；协议版本用于宿主协商）。 */
  version: typeof manifest.apiVersion === "string" ? manifest.apiVersion : "1.0.0",
  protocol: PROTOCOL,
  registerTool(def) {
    if (!def || typeof def.name !== "string" || !def.name.trim()) {
      throw new Error("registerTool 需要非空 name");
    }
    if (typeof def.execute !== "function") {
      throw new Error(`工具 ${def.name} 缺少 execute(args)`);
    }
    tools.set(def.name, def);
  },
  /** 订阅生命周期事件：必须先写进 manifest.events（宿主已按白名单校验）。 */
  on(event, handler) {
    if (typeof event !== "string" || typeof handler !== "function") {
      throw new Error("on(event, handler) 参数非法");
    }
    if (!declaredEvents.includes(event)) {
      throw new Error(`事件 ${event} 未在 manifest.events 声明`);
    }
    const list = eventHandlers.get(event) ?? [];
    list.push(handler);
    eventHandlers.set(event, list);
  },
  /** 富 UI 视图消息：扩展主动推送到自己的 iframe。 */
  sendToView(viewId, message) {
    if (typeof viewId !== "string" || !viewId) throw new Error("sendToView 需要 viewId");
    send({ type: "viewMessage", viewId, message });
  },
  /** 接收来自自己 iframe 的消息（返回值为回推消息）。 */
  onViewMessage(viewId, handler) {
    if (typeof viewId !== "string" || typeof handler !== "function") {
      throw new Error("onViewMessage(viewId, handler) 参数非法");
    }
    viewHandlers.set(viewId, handler);
  },
  log(level, message) {
    send({ type: "log", level: ["info", "warn", "error"].includes(level) ? level : "info", message: String(message) });
  },
  /** 只读上下文（扩展目录），避免扩展自行拼路径穿越。 */
  get extensionDir() {
    return extensionDir;
  },
};

async function boot() {
  if (!extensionDir || !mainRel) {
    send({ type: "fatal", message: "缺少扩展目录或入口文件参数" });
    process.exit(1);
  }
  const entry = path.resolve(extensionDir, mainRel);
  const root = path.resolve(extensionDir);
  if (entry !== root && !entry.startsWith(root + path.sep)) {
    send({ type: "fatal", message: "入口文件必须位于扩展目录内" });
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  const activate = mod.activate ?? mod.default;
  if (typeof activate !== "function") {
    send({ type: "fatal", message: "扩展缺少 activate(api) 导出" });
    process.exit(1);
  }
  await activate(api);
  const reported = [...tools.values()].map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    permissions: def.permissions,
  }));
  send({
    type: "ready",
    protocol: PROTOCOL,
    apiVersion: api.version,
    tools: reported,
    events: [...eventHandlers.keys()],
  });
}

boot().catch((err) => {
  send({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "call") {
    const def = tools.get(msg.tool);
    if (!def) {
      send({ type: "result", id: msg.id, ok: false, error: `未注册的工具：${msg.tool}` });
      return;
    }
    Promise.resolve()
      .then(() => def.execute(msg.args ?? {}, { extensionDir }))
      .then((result) => {
        if (typeof result === "string") {
          send({ type: "result", id: msg.id, ok: true, content: result });
          return;
        }
        if (result && typeof result === "object") {
          send({
            type: "result",
            id: msg.id,
            ok: result.ok !== false,
            content: typeof result.content === "string" ? result.content : result.content ? JSON.stringify(result.content) : "",
            error: typeof result.error === "string" ? result.error : undefined,
          });
          return;
        }
        send({ type: "result", id: msg.id, ok: true, content: result === undefined || result === null ? "" : String(result) });
      })
      .catch((err) => {
        send({ type: "result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return;
  }
  if (msg.type === "event") {
    const handlers = eventHandlers.get(msg.event) ?? [];
    if (handlers.length === 0) {
      send({ type: "eventResult", id: msg.id, ok: false, error: `未注册的事件：${msg.event}` });
      return;
    }
    Promise.all(handlers.map((handler) => Promise.resolve().then(() => handler(msg.payload))))
      .then((results) => {
        let allow = true;
        let reason;
        for (const result of results) {
          if (result === false) {
            allow = false;
            reason = "扩展返回 false";
          } else if (result && typeof result === "object") {
            if (result.allow === false) {
              allow = false;
              reason = typeof result.reason === "string" ? result.reason : reason;
            }
            if (typeof result.allow === "boolean" && result.allow && typeof result.reason === "string") {
              reason = result.reason;
            }
          }
        }
        send({
          type: "eventResult",
          id: msg.id,
          ok: true,
          allow,
          ...(reason ? { reason } : {}),
          result: results.length === 1 ? results[0] : results,
        });
      })
      .catch((err) => {
        send({ type: "eventResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return;
  }
  if (msg.type === "viewMessage") {
    const handler = viewHandlers.get(msg.viewId);
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(msg.message))
      .then((result) => {
        if (result !== undefined) send({ type: "viewMessage", viewId: msg.viewId, message: result });
      })
      .catch((err) => {
        send({ type: "log", level: "error", message: `view ${msg.viewId} 处理失败：${err instanceof Error ? err.message : String(err)}` });
      });
  }
});
