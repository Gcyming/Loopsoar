/**
 * 扩展富 UI 容器：沙箱 iframe（allow-scripts，不给 same-origin）。
 *
 * 通信协议（window.postMessage）：
 *   iframe → 应用：{ source: "loopsoar-extension", viewId, type: "ready"|"resize"|"message", payload?, height? }
 *   应用 → iframe：{ source: "loopsoar-host", type: "message", payload }
 * 只接受来自当前 iframe.contentWindow 的消息；sandbox 下 origin 为 "null"，以 contentWindow 绑定来源。
 * 扩展无法访问主界面 DOM / localStorage / Electron API（sandbox 唯一 origin）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import type { LoopsoarAPI } from "./types.js";

export interface ExtensionViewFrameProps {
  api: LoopsoarAPI;
  extensionId: string;
  viewId: string;
  title: string;
  entry: string;
  defaultHeight?: number;
  onClose: () => void;
}

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 1200;

export function ExtensionViewFrame({
  api,
  extensionId,
  viewId,
  title,
  entry,
  defaultHeight = 420,
  onClose,
}: ExtensionViewFrameProps): React.ReactElement {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = React.useState(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, defaultHeight)));
  const [error, setError] = React.useState<string | null>(null);
  const src = `loopsoar-ext://${encodeURIComponent(extensionId)}/${entry.split("/").map(encodeURIComponent).join("/")}`;

  React.useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      // sandbox 未给 allow-same-origin 时，iframe 的 origin 序列化为 "null"；
      // 此时 event.source 已把消息钉死在这个 iframe 上，再校验 viewId/协议字段即可。
      if (event.origin !== "null" && !event.origin.startsWith("loopsoar-ext://")) return;
      const data = event.data as
        | { source?: string; viewId?: string; type?: string; payload?: unknown; height?: number; error?: string }
        | undefined;
      if (!data || data.source !== "loopsoar-extension" || data.viewId !== viewId) return;
      if (data.type === "ready") {
        setError(null);
        return;
      }
      if (data.type === "resize" && typeof data.height === "number" && Number.isFinite(data.height)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(data.height))));
        return;
      }
      if (data.type === "error") {
        setError(data.error ?? "扩展视图报错");
        return;
      }
      if (data.type === "message") {
        void api.extensions.viewMessage({ id: extensionId, viewId, message: data.payload }).catch(() => undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api, extensionId, viewId]);

  React.useEffect(() => {
    return api.on("extensions:viewMessage", (payload) => {
      const data = payload as { id?: string; viewId?: string; message?: unknown } | undefined;
      if (!data || data.id !== extensionId || data.viewId !== viewId) return;
      frameRef.current?.contentWindow?.postMessage(
        { source: "loopsoar-host", type: "message", payload: data.message },
        "*",
      );
    });
  }, [api, extensionId, viewId]);

  return (
    <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: 10, marginTop: 10, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "6px 10px",
          background: BRAND.inkPanel,
          borderBottom: `1px solid ${BRAND.border}`,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: BRAND.linen }}>{title}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: "none",
            background: "transparent",
            color: BRAND.linenFaint,
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          收起
        </button>
      </div>
      {error ? (
        <div style={{ padding: "8px 10px", fontSize: 11.5, color: BRAND.danger }}>{error}</div>
      ) : null}
      <iframe
        ref={frameRef}
        title={`${extensionId}:${viewId}`}
        src={src}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: "none", background: "transparent", display: "block" }}
      />
    </div>
  );
}
