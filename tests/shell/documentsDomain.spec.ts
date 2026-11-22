import { beforeEach, describe, expect, it } from "vitest";
import { registerDocumentsDomain } from "../../packages/shell/src/main/domains/documents.ts";
import { __resetHandlerRegistryForTests, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const opened: Array<{ id: number; file: string }> = [];
  const deps: TrustedIpcDeps & {
    browserHost: {
      hasWebContents: (id: number) => boolean;
      handleLocalFilePath: (id: number, file: string) => boolean;
    };
    openDocument: (file: string) => Promise<{ ok: boolean }>;
  } = {
    ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
    audit: () => undefined,
    openDocument: async () => ({ ok: true }),
    browserHost: {
      hasWebContents: (id) => id === 7,
      handleLocalFilePath: (id, file) => {
        opened.push({ id, file });
        return /\.docx$/i.test(file);
      },
    },
  };
  registerDocumentsDomain(deps);
  return { handlers, opened };
}

describe("documents 域：浏览器页拖放", () => {
  beforeEach(() => __resetHandlerRegistryForTests());

  it("只接受属于浏览器标签的发送者，并把路径转给宿主", async () => {
    const { handlers, opened } = harness();
    const handler = handlers.get("loopsoar-browser:local-file-drop");
    expect(handler).toBeTypeOf("function");
    await expect(handler!({ sender: { id: 7 } }, { path: "C:/docs/a.docx" })).resolves.toEqual({ ok: true });
    expect(opened).toEqual([{ id: 7, file: "C:/docs/a.docx" }]);
  });

  it("拒绝非浏览器标签来源与非法路径", async () => {
    const { handlers, opened } = harness();
    const handler = handlers.get("loopsoar-browser:local-file-drop")!;
    await expect(handler({ sender: { id: 9 } }, { path: "C:/docs/a.docx" })).resolves.toEqual({
      ok: false,
      error: "来源不是 Loopsoar 浏览器标签页",
    });
    await expect(handler({ sender: { id: 7 } }, { path: "" })).resolves.toEqual({
      ok: false,
      error: "文件路径非法",
    });
    await expect(handler({ sender: { id: 7 } }, { path: "C:/docs/a.txt" })).resolves.toEqual({
      ok: false,
      error: "不支持的文档类型或标签已关闭",
    });
    expect(opened).toEqual([{ id: 7, file: "C:/docs/a.txt" }]);
  });
});
