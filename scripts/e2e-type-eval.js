(async () => {
  // 逐字真实键盘输入验收（渲染层执行）：配 mock → 建会话开浏览器控制 → 让 Agent 在 #name 输入中文+英文+数字 → 取证。
  const api = window.loopsoarAPI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: false, steps: [] };
  if (!api) return { error: "window.loopsoarAPI 不存在" };
  const TYPED = "Loopsoar 中文 123";
  try {
    const skipBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "跳过");
    if (skipBtn) {
      skipBtn.click();
      await sleep(500);
    }
    const provider = await api.settings.upsertProvider({
      provider: "mock-type",
      baseUrl: "http://127.0.0.1:19501/v1",
      model: "mock-model",
      apiFormat: "openai",
    });
    const key = await api.settings.setApiKey({ apiKey: "sk-mock-e2e", providerId: provider?.item?.id });
    out.steps.push({ step: "provider", id: provider?.item?.id ?? null, keySaved: key?.saved ?? null });

    const created = await api.chat.newSession({});
    const sid = created?.session?.sessionId ?? null;
    out.sessionId = sid;
    if (!sid) return { ...out, error: "建会话失败" };
    out.steps.push({ step: "browserControl", ok: (await api.chat.setBrowserControl({ sessionId: sid, enabled: true }))?.ok ?? null });

    const accepted = await api.chat.stream({
      message: "打开 http://127.0.0.1:19444/ ，在名字输入框输入「Loopsoar 中文 123」，然后读取页面确认",
      sessionId: sid,
      mode: "build",
    });
    out.steps.push({ step: "stream", accepted: accepted?.accepted ?? null });

    await sleep(24000);

    let history = null;
    try {
      history = await api.chat.history();
    } catch (err) {
      out.historyError = err && err.message ? err.message : String(err);
    }
    const messages = history?.session?.messages ?? [];
    const joined = messages.map((m) => String(m.text ?? "")).join("\n");
    out.historyText = joined.slice(-900);
    const keyMatch = /keydown=(\d+)/.exec(joined);
    out.evidence = {
      navigated: joined.includes("127.0.0.1:19444") || joined.includes("Loopsoar E2E 本地页"),
      snapshotWithRefs: /快照 #\d+/.test(joined) && joined.includes("#e"),
      // 关键证据：输入框的 value 出现在快照里
      typedValue: joined.includes(TYPED),
      // 更强证据：页面累计到了可信 keydown（原生 setter 路径为 0，说明确实走了真实键盘）
      keydowns: keyMatch ? Number(keyMatch[1]) : 0,
    };
    out.ok =
      out.evidence.navigated &&
      out.evidence.snapshotWithRefs &&
      out.evidence.typedValue &&
      out.evidence.keydowns > 0;
    return out;
  } catch (err) {
    return { ...out, error: err && err.message ? err.message : String(err) };
  }
})()