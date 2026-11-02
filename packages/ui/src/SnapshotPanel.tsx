/**
 * 页面快照面板：把 `browser.snapshot()` 的结果从「toast 一行字」升级成可读浮层。
 *
 * 用途：Agent 与人共享同一份「网页可读视图」——正文可滚动/一键复制，
 * 可交互元素列表（编号 + 文本）便于人对照 Agent 接下来要点的目标。
 * 组件只做展示：数据由 App 调 browser:snapshot 传入，关闭回调交还 App。
 */
import * as React from "react";
import { Icon } from "./Icon.js";
import type { BrowserSnapshotResult } from "./types.js";

export interface SnapshotPanelProps {
  /** null = 面板关闭（App 用同一状态驱动原生视图遮挡开关）。 */
  snapshot: BrowserSnapshotResult | null;
  onClose: () => void;
}

/** 可交互元素最多展示条数（后端快照本身已有上限；这里再兜一层渲染成本）。 */
const MAX_ELEMENTS = 100;

export default function SnapshotPanel({ snapshot, onClose }: SnapshotPanelProps): React.JSX.Element | null {
  const titleId = React.useId();
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const copiedTimerRef = React.useRef<number | null>(null);
  const [copied, setCopied] = React.useState<"" | "text" | "url">("");

  // 打开时把焦点放到关闭按钮（Esc 也能关；避免焦点留在被遮住的网页/顶栏）
  React.useEffect(() => {
    if (!snapshot) return;
    closeButtonRef.current?.focus();
  }, [snapshot]);

  // Esc 关闭：捕获阶段处理，避免同时触发其它面板的 Esc（下层设置面板等）
  React.useEffect(() => {
    if (!snapshot) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [snapshot, onClose]);

  React.useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copy = React.useCallback(async (value: string, kind: "text" | "url"): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(""), 1800);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：保持按钮文案不变，不弹错误打断阅读
    }
  }, []);

  if (!snapshot) return null;
  const text = snapshot.text ?? "";
  const elements = snapshot.elements ?? snapshot.interactive ?? [];
  const shown = elements.slice(0, MAX_ELEMENTS);

  return (
    <div
      className="snapshot-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="snapshot-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="snapshot-head">
          <span id={titleId} className="snapshot-title" title={snapshot.title || "（无标题）"}>
            {snapshot.title || "（无标题）"}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            title="关闭（Esc）"
            aria-label="关闭快照面板"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="snapshot-url" title={snapshot.url || ""}>
          {snapshot.url || "（无 URL）"}
        </div>
        <div className="snapshot-meta">
          正文 {text.length.toLocaleString("zh-CN")} 字符 · 可交互元素 {elements.length} 个
          {elements.length > MAX_ELEMENTS ? `（展示前 ${MAX_ELEMENTS} 个）` : ""}
        </div>
        <pre className="snapshot-text" tabIndex={0} aria-label="页面正文（可滚动）">
          {text || "（页面没有可提取的正文）"}
        </pre>
        {shown.length > 0 ? (
          <div className="snapshot-elements">
            <div className="snapshot-elements-title">可交互元素</div>
            <div className="snapshot-elements-list">
              {shown.map((element, index) => (
                <div key={`${element.id ?? index}-${index}`} className="snapshot-element">
                  <span className="snapshot-element-id">#{element.id ?? index}</span>
                  <span className="snapshot-element-tag">
                    {element.tag ?? "?"}
                    {element.type ? `[${element.type}]` : ""}
                  </span>
                  <span className="snapshot-element-text" title={element.text || ""}>
                    {element.text || "（无文本）"}
                  </span>
                  {element.href ? (
                    <span className="snapshot-element-href" title={element.href}>
                      {element.href}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <footer className="snapshot-actions">
          <button
            type="button"
            className="snapshot-btn"
            onClick={() => void copy(text, "text")}
            disabled={!text}
            title="复制整页可读正文"
          >
            {copied === "text" ? "已复制正文" : "复制正文"}
          </button>
          <button
            type="button"
            className="snapshot-btn"
            onClick={() => void copy(snapshot.url ?? "", "url")}
            disabled={!snapshot.url}
            title="复制页面 URL"
          >
            {copied === "url" ? "已复制链接" : "复制链接"}
          </button>
          <button type="button" className="snapshot-btn snapshot-close" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
