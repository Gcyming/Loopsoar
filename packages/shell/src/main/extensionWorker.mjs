/**
 * 扩展 worker 进程（由 ExtensionRuntime spawn；不 import electron）。
 * 用法：node extensionWorker.mjs <extensionDir> <mainRel>
 * 协议：stdin/stdout 行分隔 JSON（见 packages/core/src/extensionWorker.ts）。
 *
 * 扩展模块契约（ESM）：
 *   export async function activate(api) { api.registerTool({ name, description, parameters, permissions, execute }) }
 *   或 export default activate
 * 每个工具的 execute(args, ctx) 可返回 string 或 { ok, content, error }。
 */
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const [, , extensionDir, mainRel] = process.argv;

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // stdout 已关闭：worker 即将退出
  }
}

const tools = new Map();
const api = {
  registerTool(def) {
    if (!def || typeof def.name !== "string" || !def.name.trim()) {
      throw new Error("registerTool 需要非空 name");
    }
    if (typeof def.execute !== "function") {
      throw new Error(`工具 ${def.name} 缺少 execute(args)`);
    }
    tools.set(def.name, def);
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
  if (!entry.startsWith(root + path.sep)) {
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
  send({ type: "ready", tools: reported });
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
  if (msg.type !== "call") return;
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
});
