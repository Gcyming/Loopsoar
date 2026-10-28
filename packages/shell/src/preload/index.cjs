// Loopsoar preload（CJS 原样文件，不经 tsc）：
// 契约白名单经 additionalArguments 注入，避免 CJS/ESM 互操作问题。
// 只暴露 window.loopsoarAPI（域方法 + on 事件订阅），不暴露原始 ipcRenderer。
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

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
