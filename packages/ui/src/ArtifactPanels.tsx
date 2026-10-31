/**
 * 会话级产物与引用面板（对齐 slime 的 ProductPanel / RefPanel / UrlPanel）：
 *   · ProductPanel：本轮写过的文件（文件名 + 读写 + 改动行数 + 展开 diff）；
 *   · RefPanel：读过的本地文件；
 *   · UrlPanel：访问过的网址（点击在 Loopsoar 内新标签打开）。
 * 数据全部来自时间线（collectReferences / collectProducts），不引入第二份状态。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import DiffBlock from "./DiffBlock.js";
import type { ProductFile, ReferenceGroups } from "./artifacts.js";

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        flexShrink: 0,
        color: BRAND.linenFaint,
        fontSize: 11,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 140ms ease",
      }}
    >
      ›
    </span>
  );
}

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={`collapse${open ? " is-open" : ""}`}>
      <div>{children}</div>
    </div>
  );
}

export function UrlPanel({ urls, onOpenUrl }: { urls: ReferenceGroups["urls"]; onOpenUrl?: (url: string) => void }): React.ReactElement | null {
  if (urls.length === 0) return null;
  return (
    <div className="ref-panel">
      <div className="ref-panel-head"><span aria-hidden>🌐</span> 访问来源 <span className="ref-panel-count">{urls.length}</span></div>
      <div className="ref-panel-list">
        {urls.map((item) => (
          <a
            key={item.url}
            href={item.url}
            className="ref-chip"
            title={item.url}
            onClick={(event) => {
              event.preventDefault();
              onOpenUrl?.(item.url);
            }}
          >
            {item.label}
          </a>
        ))}
      </div>
    </div>
  );
}

export function RefPanel({ files }: { files: ReferenceGroups["files"] }): React.ReactElement | null {
  if (files.length === 0) return null;
  const [open, setOpen] = React.useState(false);
  return (
    <div className="ref-panel">
      <button type="button" className="ref-panel-head is-button" onClick={() => setOpen((value) => !value)} title={open ? "收起参考文件" : "展开参考文件"}>
        <Chevron open={open} />
        <span aria-hidden>📄</span>
        <span>参考内容</span>
        <span className="ref-panel-count">{files.length}</span>
      </button>
      <Collapse open={open}>
        <div className="ref-panel-list">
          {files.map((file) => (
            <span key={file.path} className="ref-chip" title={file.path}>{file.label}</span>
          ))}
        </div>
      </Collapse>
    </div>
  );
}

export function ProductPanel({ products, defaultOpen = false }: { products: ProductFile[]; defaultOpen?: boolean }): React.ReactElement | null {
  const [openPath, setOpenPath] = React.useState<string | null>(defaultOpen && products[0] ? products[0].path : null);
  if (products.length === 0) return null;
  return (
    <div className="product-panel">
      <div className="product-panel-head">产物 <span className="ref-panel-count">{products.length}</span></div>
      <div className="product-grid">
        {products.map((product) => {
          const open = openPath === product.path;
          return (
            <div key={product.path} className={`product-card${open ? " is-open" : ""}`}>
              <button type="button" className="product-card-head" onClick={() => setOpenPath(open ? null : product.path)} title={open ? "收起改动" : "展开改动"}>
                <Chevron open={open} />
                <span className="product-card-icon" aria-hidden>📄</span>
                <span className="product-card-name" title={product.path}>{product.label}</span>
                <span className="product-card-stat">
                  <span className="think-diff-add">+{product.add}</span>
                  <span className="think-diff-del">−{product.del}</span>
                </span>
                <span className="product-card-path" title={product.path}>{product.path}</span>
              </button>
              <Collapse open={open}>
                <div className="product-card-body">
                  <DiffBlock oldText={product.oldText} newText={product.newText} path={product.path} />
                </div>
              </Collapse>
            </div>
          );
        })}
      </div>
    </div>
  );
}
