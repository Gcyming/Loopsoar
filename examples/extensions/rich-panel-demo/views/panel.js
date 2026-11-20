const viewId = "panel";
const out = document.getElementById("out");
const input = document.getElementById("text");

function post(type, extra = {}) {
  window.parent.postMessage({ source: "loopsoar-extension", viewId, type, ...extra }, "*");
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "loopsoar-host" || data.type !== "message") return;
  out.textContent = JSON.stringify(data.payload, null, 2);
});

document.getElementById("send").addEventListener("click", () => {
  post("message", { payload: { text: input.value, sentAt: Date.now() } });
});

new ResizeObserver(() => post("resize", { height: document.body.scrollHeight + 16 })).observe(document.body);
post("ready");
