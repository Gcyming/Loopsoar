/**
 * 下载条目图标：优先取下载来源站点的 favicon（与浏览器标签一致的站点图标），
 * 取不到时按文件扩展名显示带颜色的类型徽标（PPT/EXE/ZIP/...）。
 * 站点图标按 origin 缓存，避免列表里每行重复请求。
 */
import * as React from "react";
import { useLoopsoarApi } from "./useLoopsoarApi.js";

const faviconCache = new Map<string, string | null>();
const faviconInflight = new Map<string, Promise<string | null>>();

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

const COLORS: Record<string, string> = {
  ppt: "#d24726", pptx: "#d24726",
  doc: "#2b579a", docx: "#2b579a",
  xls: "#217346", xlsx: "#217346",
  pdf: "#d93025",
  zip: "#b06000", rar: "#b06000", "7z": "#b06000",
  exe: "#5f6368", msi: "#5f6368",
  svg: "#7c3aed", png: "#7c3aed", jpg: "#7c3aed", jpeg: "#7c3aed", gif: "#7c3aed", webp: "#7c3aed", avif: "#7c3aed",
  mp4: "#0f9d58", mp3: "#0f9d58", mrp: "#0f9d58",
};

const LABELS: Record<string, string> = {
  ppt: "PPT", pptx: "PPT", doc: "DOC", docx: "DOC", xls: "XLS", xlsx: "XLS", pdf: "PDF",
  zip: "ZIP", rar: "RAR", "7z": "7Z", exe: "EXE", msi: "MSI", svg: "SVG", png: "PNG",
  jpg: "JPG", jpeg: "JPG", gif: "GIF", webp: "WEBP", avif: "AVIF", mp4: "MP4", mp3: "MP3", mrp: "MRP",
};

export default function DownloadIcon({
  url,
  filename,
  size = 16,
}: {
  url: string;
  filename: string;
  size?: number;
}): React.ReactElement {
  const api = useLoopsoarApi();
  const origin = originOf(url);
  const [favicon, setFavicon] = React.useState<string | null>(origin ? faviconCache.get(origin) ?? null : null);

  React.useEffect(() => {
    if (!origin || !api?.browser?.resolveFavicon) return;
    if (faviconCache.has(origin)) {
      setFavicon(faviconCache.get(origin) ?? null);
      return;
    }
    let alive = true;
    const existing = faviconInflight.get(origin);
    const request =
      existing ??
      api.browser
        .resolveFavicon({ url })
        .then((result) => result?.favicon ?? null)
        .catch(() => null);
    if (!existing) faviconInflight.set(origin, request);
    void request.then((icon) => {
      faviconCache.set(origin, icon);
      faviconInflight.delete(origin);
      if (alive) setFavicon(icon);
    });
    return () => {
      alive = false;
    };
  }, [api, origin, url]);

  if (favicon) {
    return (
      <img
        src={favicon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: 3, objectFit: "contain", flex: "0 0 auto" }}
      />
    );
  }
  const ext = extensionOf(filename);
  const label = LABELS[ext] ?? (ext ? ext.slice(0, 3).toUpperCase() : "FILE");
  const color = COLORS[ext] ?? "#5f6368";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        background: color,
        color: "#fff",
        fontSize: Math.max(6, Math.round(size * 0.4)),
        fontWeight: 700,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
      }}
    >
      {label.slice(0, 4)}
    </span>
  );
}
