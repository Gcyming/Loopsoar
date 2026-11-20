import { describe, expect, it, vi } from "vitest";
import { uploadFileInput } from "../../packages/shell/src/main/browserUpload.js";

function makeWc() {
  const commands: string[] = [];
  const debuggerLike = {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand(method: string) {
      commands.push(method);
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") {
        return { node: { nodeName: "INPUT", attributes: ["type", "file", "id", "f"] } };
      }
      return {};
    },
  };
  return { wc: { id: 1, debugger: debuggerLike, isDestroyed: () => false }, commands, debuggerLike };
}

describe("browser upload", () => {
  it("选择 file input 并调用 DOM.setFileInputFiles", async () => {
    const { wc, commands, debuggerLike } = makeWc();
    const result = await uploadFileInput(wc, "input[type=file]", ["C:/tmp/a.txt"]);
    expect(result.ok).toBe(true);
    expect(commands).toContain("DOM.setFileInputFiles");
    expect(debuggerLike.attached).toBe(false);
  });

  it("目标不是 input[type=file] 时拒绝", async () => {
    const { wc } = makeWc();
    wc.debugger.sendCommand = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") return { node: { nodeName: "DIV" } };
      return {};
    }) as any;
    const result = await uploadFileInput(wc, "div", ["a.txt"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是 input");
  });

  it("选择器无匹配时返回可读错误", async () => {
    const { wc } = makeWc();
    wc.debugger.sendCommand = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 0 };
      return {};
    }) as any;
    const result = await uploadFileInput(wc, "input[type=file]", ["a.txt"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("没有匹配");
  });
});
