// Loopsoar preload（CJS 原样文件，不经 tsc）：
// 契约白名单经 additionalArguments 注入，避免 CJS/ESM 互操作问题。
// 只暴露 window.loopsoarAPI（域方法 + on 事件订阅），不暴露原始 ipcRenderer。
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function argValue(prefix) {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : "[]";
}

const bindings = JSON.parse(argValue("--loopsoar-bindings=")); // [{channel, domain, method}]
const events = JSON.parse(argValue("--loopsoar-events=")); // 契约事件白名单

const api = {};
for (const b of bindings) {
  if (!api[b.domain]) api[b.domain] = {};
  api[b.domain][b.method] = (payload) =>
    ipcRenderer.invoke(`loopsoar:${b.channel}`, payload);
}

const eventSet = new Set(events);
api.on = (event, cb) => {
  if (!eventSet.has(event)) {
    throw new Error(`事件 ${event} 不在契约白名单`);
  }
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(`loopsoar:${event}`, listener);
  return () => ipcRenderer.removeListener(`loopsoar:${event}`, listener);
};

contextBridge.exposeInMainWorld("loopsoarAPI", api);

/**
 * Office 文档拖入应用：Chromium 默认会导航到 file://（主窗口变白）或走下载弹 Save As。
 * 在主世界之前的 preload 捕获阶段截住并交给主进程转换/预览；非 Office 文件保持原行为，
 * 这样网页/输入框自己的文件拖放能力不会被误伤。
 */
const OFFICE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf", ".odt", ".ott",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm", ".csv", ".ods", ".ots",
  ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".ppsm", ".pot", ".potx", ".potm", ".odp", ".otp",
]);

function officePathOf(file) {
  let filePath = "";
  try {
    if (webUtils && typeof webUtils.getPathForFile === "function") {
      filePath = webUtils.getPathForFile(file) || "";
    }
  } catch {
    filePath = "";
  }
  if (!filePath) filePath = String(file?.path || "");
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "";
  return OFFICE_EXTENSIONS.has(filePath.slice(dot).toLowerCase()) ? filePath : "";
}

function installOfficeDropHandler() {
  if (!api.documents || !webUtils || typeof webUtils.getPathForFile !== "function") return;
  window.addEventListener("dragover", (event) => {
    const types = event.dataTransfer && Array.from(event.dataTransfer.types || []);
    if (types && types.includes("Files")) event.preventDefault();
  }, true);
  window.addEventListener("drop", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const files = Array.from(transfer.files || []);
    if (!files.length) return;
    const paths = files.map(officePathOf).filter(Boolean);
    if (!paths.length) return;
    event.preventDefault();
    event.stopPropagation();
    const path = paths[0];
    void api.documents.open({ path })
      .then((result) => {
        if (result && result.ok === false) {
          void api.ui?.toast?.({ text: result.error || "无法打开文档", sticky: true }).catch(() => undefined);
        }
      })
      .catch((err) => {
        void api.ui?.toast?.({ text: err instanceof Error ? err.message : String(err), sticky: true }).catch(() => undefined);
      });
  }, true);
}

installOfficeDropHandler();
