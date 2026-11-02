/**
 * 插件 worker 进程（由 PluginRuntime spawn；不 import electron）。
 * 用法：node pluginWorker.mjs <pluginDir> <mainRel>
 * 协议：stdin/stdout 行分隔 JSON（与 extensionWorker 同构，见 packages/core/src/extensionWorker.ts）。
 *
 * 插件模块契约（ESM）：
 *   export async function activate(api) { api.registerTool({ name, description, parameters, permissions, execute }) }
 *   或 export default activate
 * 工具 execute(args, ctx) 可返回 string 或 { ok, content, error }。
 * 隔离原则：worker 只拿到插件目录与一个最小 api，没有文件/网络/进程权限扩展（沙箱在父进程判定）。
 */
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const [, , pluginDir, mainRel] = process.argv;
const pluginId = process.env.LOOPSOAR_PLUGIN_ID ?? "unknown";

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
  /** 结构化日志（父进程保留最近若干行，用于面板错误展示）。 */
  log(message) {
    send({ type: "log", message: typeof message === "string" ? message : JSON.stringify(message) });
  },
  /** 只读上下文：插件 id / 目录（避免插件自行拼路径穿越）。 */
  get pluginId() {
    return pluginId;
  },
  get pluginDir() {
    return pluginDir;
  },
};

async function boot() {
  if (!pluginDir || !mainRel) {
    send({ type: "fatal", message: "缺少插件目录或入口文件参数" });
    process.exit(1);
  }
  const root = path.resolve(pluginDir);
  const entry = path.resolve(root, mainRel);
  if (entry !== root && !entry.startsWith(root + path.sep)) {
    send({ type: "fatal", message: "入口文件必须位于插件目录内" });
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  const activate = mod.activate ?? mod.default;
  if (typeof activate !== "function") {
    send({ type: "fatal", message: "插件缺少 activate(api) 导出" });
    process.exit(1);
  }
  await activate(api);
  const reported = [...tools.values()].map((def) => ({
    name: def.name,
    description: typeof def.description === "string" ? def.description : undefined,
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
    .then(() => def.execute(msg.args ?? {}, { pluginId, pluginDir }))
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
          content:
            typeof result.content === "string"
              ? result.content
              : result.content
                ? JSON.stringify(result.content)
                : "",
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
