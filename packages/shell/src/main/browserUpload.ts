/**
 * 给页面里的 input[type=file] 选择本地文件（CDP DOM.setFileInputFiles）。
 *
 * 为什么不用页面 JS 伪造 File：浏览器安全模型不允许页面读取任意本地文件；CDP 是唯一
 * 既真实又不需要在渲染进程开 Node 的通道。文件路径必须由主进程先做会话根目录校验，
 * 这里只负责「选择器 → DOM 节点 → setFileInputFiles」。
 */

interface DebuggerLike {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface CdpNode {
  nodeId?: number;
  nodeName?: string;
  attributes?: string[];
}

export interface UploadResult {
  ok: boolean;
  message: string;
}

export async function uploadFileInput(
  webContents: unknown,
  selector: string,
  files: string[],
): Promise<UploadResult> {
  const wc = webContents as { debugger?: DebuggerLike; isDestroyed?: () => boolean } | undefined;
  if (!wc || wc.isDestroyed?.()) return { ok: false, message: "页面已关闭" };
  const dbg = wc.debugger;
  if (!dbg) return { ok: false, message: "当前运行环境不支持文件上传（缺少 debugger）" };
  if (files.length === 0) return { ok: false, message: "没有要上传的文件" };

  const wasAttached = dbg.isAttached();
  try {
    if (!wasAttached) dbg.attach("1.3");
    await dbg.sendCommand("DOM.enable");
    const doc = (await dbg.sendCommand("DOM.getDocument", { depth: -1 })) as { root?: CdpNode };
    const rootId = doc.root?.nodeId;
    if (typeof rootId !== "number") return { ok: false, message: "无法读取页面 DOM 根节点" };

    const query = (await dbg.sendCommand("DOM.querySelector", {
      nodeId: rootId,
      selector,
    })) as { nodeId?: number };
    if (typeof query.nodeId !== "number" || query.nodeId === 0) {
      return { ok: false, message: `选择器没有匹配到元素：${selector}` };
    }

    const described = (await dbg.sendCommand("DOM.describeNode", {
      nodeId: query.nodeId,
    })) as { node?: CdpNode };
    const node = described.node;
    if (node?.nodeName?.toLowerCase() !== "input") {
      return { ok: false, message: `目标不是 input 元素：${selector}` };
    }
    const attrs = node.attributes ?? [];
    let type = "";
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i].toLowerCase() === "type") type = attrs[i + 1].toLowerCase();
    }
    if (type !== "file") return { ok: false, message: `目标不是 input[type=file]：${selector}` };

    await dbg.sendCommand("DOM.setFileInputFiles", {
      nodeId: query.nodeId,
      files,
    });
    return { ok: true, message: `已向 ${selector} 选择 ${files.length} 个文件` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!wasAttached) {
      try {
        dbg.detach();
      } catch {
        // debugger 可能已被页面/devtools 关闭；不影响上传结果
      }
    }
  }
}
