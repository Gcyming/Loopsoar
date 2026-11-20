(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen = [];
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "loopsoar-extension") return;
    seen.push({ origin: event.origin, type: data.type, viewId: data.viewId, height: data.height });
  });
  // 等设置分区与扩展列表 IPC 渲染完成
  await sleep(2500);
  const list = await window.loopsoarAPI.extensions.list().catch((error) => ({ error: String(error) }));
  const buttons = [...document.querySelectorAll("button")];
  const open = buttons.find((button) => /^(Rich Panel|面板)$/.test((button.textContent || "").trim()));
  if (!open) {
    return {
      ok: false,
      error: "view button not found",
      list,
      labels: buttons.map((button) => (button.textContent || "").trim()).filter(Boolean).slice(0, 60),
      bodyHasEmpty: /没有安装扩展|No extensions/.test(document.body.innerText),
      snippet: document.body.innerText.slice(0, 1200),
    };
  }
  open.click();
  await sleep(2500);
  const frame = document.querySelector('iframe[title="rich-panel-demo:panel"]');
  const viewMessage = await window.loopsoarAPI.extensions
    .viewMessage({ id: "rich-panel-demo", viewId: "panel", message: { text: "ping" } })
    .catch((error) => ({ ok: false, error: String(error) }));
  await sleep(500);
  return {
    ok: seen.some((item) => item.type === "ready") && seen.some((item) => item.type === "resize"),
    clicked: true,
    frame: frame ? frame.getAttribute("src") : null,
    sandbox: frame ? frame.getAttribute("sandbox") : null,
    seen,
    viewMessage,
    origin: location.origin,
  };
})()
