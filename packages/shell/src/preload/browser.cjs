/**
 * 浏览器标签页专用 preload（WebContentsView）。
 *
 * 只做一件事：在 Chrome / Edge 应用商店详情页拦截「添加至浏览器 / Add to Chrome」
 * 按钮点击，改走 Loopsoar 的扩展安装通道（Electron 没有 chrome.webstore.install，
 * 原按钮点击会静默无反应 —— 用户 m09029 反馈）。
 *
 * 安全：
 *   · 仅当 location 是官方商店域名时安装点击代理；
 *   · 只发送「商店 ID」这一个字段给主进程，主进程再校验发送者必须是 Loopsoar 的浏览器标签；
 *   · 不向页面暴露任何 Node/Electron 能力（contextIsolation + sandbox）。
 *
 * 说明：sandbox 下的 preload 只能 require('electron') 等少数模块，因此匹配函数内联在本文件，
 * 并在 Node 环境（单测）通过 module.exports 导出纯函数。
 */
"use strict";

let ipcRenderer = null;
try {
  // sandbox preload 允许 require('electron')；Node 单测里拿到的是 electron 可执行路径字符串。
  const electron = require("electron");
  ipcRenderer = typeof electron === "object" && electron ? electron.ipcRenderer : null;
} catch {
  ipcRenderer = null;
}

const CHROME_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);
const EDGE_HOSTS = new Set(["microsoftedge.microsoft.com"]);

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 是否 Chrome/Edge 应用商店页面。 */
function isWebStoreUrl(rawUrl) {
  const host = hostOf(rawUrl);
  return CHROME_HOSTS.has(host) || EDGE_HOSTS.has(host) || host.endsWith(".microsoftedge.microsoft.com");
}

/** 从商店详情页 URL 提取扩展 ID（Chromium 系 32 位 a-p）。 */
function extractStoreId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const m =
      url.pathname.match(/\/detail\/[^/]+\/([a-p]{32})(?:\/|$)/) ||
      url.pathname.match(/\/(?:detail\/[^/]+\/)?([a-p]{32})(?:\/|$)/) ||
      url.searchParams.get("id");
    const value = Array.isArray(m) ? m[1] : m;
    return value && /^[a-p]{32}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** 商店 “添加至 Chrome / Add to Chrome / 获取” 等按钮文案判定。 */
function isInstallButtonText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/remove|卸载|删除/i.test(normalized)) return false;
  return /add to chrome|添加至 chrome|添加到 chrome|add to edge|添加到 edge|获取扩展|获取|install/i.test(normalized);
}

function toast(text, kind) {
  try {
    const existing = document.getElementById("loopsoar-webstore-toast");
    const node = existing || document.createElement("div");
    node.id = "loopsoar-webstore-toast";
    node.textContent = text;
    node.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:28px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "max-width:min(560px,80vw)",
      "padding:10px 16px",
      "border-radius:10px",
      "font:13px/1.5 system-ui,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
      "background:" + (kind === false ? "#7f1d1d" : "#1f2937"),
      "color:#f9fafb",
      "border:1px solid " + (kind === false ? "rgba(248,113,113,0.6)" : "rgba(200,118,60,0.55)"),
      "pointer-events:none",
      "transition:opacity 200ms ease",
    ].join(";");
    if (!existing) document.documentElement.appendChild(node);
    if (kind === true) {
      window.setTimeout(() => {
        node.style.opacity = "0";
      }, 3200);
    }
  } catch {
    // 页面 DOM 异常时静默
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isWebStoreUrl, extractStoreId, isInstallButtonText, hostOf };
}

if (ipcRenderer && typeof location !== "undefined" && isWebStoreUrl(location.href)) {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest("button, [role='button'], a") : null;
      if (!target) return;
      const label = [target.getAttribute("aria-label"), target.textContent].filter(Boolean).join(" ");
      if (!isInstallButtonText(label)) return;
      const id = extractStoreId(location.href);
      if (!id) return;
      // 阻止商店脚本走 Electron 不支持的安装路径（原行为：静默无反应）
      event.preventDefault();
      event.stopPropagation();
      toast("Loopsoar 正在安装扩展…");
      ipcRenderer
        .invoke("loopsoar-browser:install-extension", { id })
        .then((result) => {
          if (result && result.ok) toast(`扩展已安装：${result.name ?? id}（重启后仍保留）`, true);
          else toast(`安装失败：${(result && result.error) || "未知错误"}`, false);
        })
        .catch((err) => toast(`安装失败：${err instanceof Error ? err.message : String(err)}`, false));
    },
    true,
  );
}
