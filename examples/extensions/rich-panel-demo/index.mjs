/**
 * 富 UI + 事件扩展示例（worker 协议 v2）。
 * 运行：把整个目录复制到 <dataDir>/extensions/ 或在设置·扩展里安装目录。
 */
export async function activate(api) {
  api.registerTool({
    name: "greet",
    description: "按名字问候（示例工具）",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "要问候的名字" } },
      required: ["name"],
      additionalProperties: false,
    },
    permissions: { read: true },
    execute: async ({ name }) => ({ content: `Hello, ${String(name || "world")}!` }),
  });

  // 视图发来的消息 → 回推一条消息给同一个 iframe。
  api.onViewMessage("panel", (message) => ({
    echo: message,
    handledAt: new Date().toISOString(),
  }));

  api.log("info", "rich-panel-demo activated");
}
