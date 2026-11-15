(async () => {
  // 第二阶段端到端场景（渲染层执行）：配 mock 供应商 → 建会话开「浏览器控制」→ 发指令 →
  // mock LLM 依次要求 navigate / snapshot / click / snapshot → 用界面按钮真实回答「布局询问」→ 取证。
  const api = window.loopsoarAPI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: false, steps: [] };
  if (!api) return { error: "window.loopsoarAPI 不存在" };
  try {
    // 首次启动会弹「欢迎使用 Loopsoar」引导层，先跳过，让证据截图能拍到真实会话
    const skipBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "跳过");
    if (skipBtn) {
      skipBtn.click();
      await sleep(500);
    }
    const provider = await api.settings.upsertProvider({
      provider: "mock-p2",
      baseUrl: "http://127.0.0.1:19500/v1",
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

    // 布局询问：等弹窗出现后用真实按钮回答（验证功能②的界面链路，而不是绕过 UI）
    let askSeen = null;
    const off = api.on("ask:user", (payload) => {
      askSeen = { question: String(payload?.question ?? "").slice(0, 700), options: payload?.options ?? [] };
      void (async () => {
        await sleep(700);
        const wanted = (payload?.options ?? [])[0];
        const buttons = Array.from(document.querySelectorAll("button"));
        const target = buttons.find((el) => (el.textContent || "").trim() === String(wanted));
        if (target) {
          target.click();
          out.askAnsweredByClick = true;
        } else {
          out.askAnsweredByApi = true;
          await api.ask.respond({ requestId: payload?.requestId, answer: wanted });
        }
      })();
    });

    // 先像用户一样打开一个页面：Agent 首次动手时应克隆它（原页保留），而不是接管它。
    const opened = await api.browser.navigate({ url: "http://127.0.0.1:19443/" });
    out.steps.push({ step: "userTab", ok: opened?.ok ?? null });

    const accepted = await api.chat.stream({
      message: "打开 http://127.0.0.1:19443/ ，点击「点我」按钮，然后告诉我结果",
      sessionId: sid,
      mode: "build",
    });
    out.steps.push({ step: "stream", accepted: accepted?.accepted ?? null });

    await sleep(26000);
    off?.();

    // 壳层真值：会话历史（工具结果会被回灌进助手消息文本）
    let history = null;
    try {
      history = await api.chat.history();
    } catch (err) {
      out.historyError = err && err.message ? err.message : String(err);
    }
    const messages = history?.session?.messages ?? [];
    const joined = messages.map((m) => String(m.text ?? "")).join("\n");
    out.historyText = joined.slice(-900);
    out.askSeen = askSeen;
    // 布局询问已在 Slice E 之后取消：默认 docked（设置·通用里可选），所以不再要求 ask 证据。
    // 任务化证据：用户页 + Agent 克隆页并存（原页必须还在，且只有克隆页带 agentBound）。
    let tabs = [];
    let userTabs = 0;
    let agentTabs = 0;
    try {
      tabs = (await api.browser.listTabs())?.tabs ?? [];
      agentTabs = tabs.filter((tab) => tab.agentBound === true).length;
      // 全局用户标签独立于会话：先切回用户组再数，最后回到任务组。
      await api.browser.showUserTabs();
      userTabs = ((await api.browser.listTabs())?.tabs ?? []).filter((tab) => tab.agentBound !== true).length;
      if (sid) await api.browser.showTask({ sessionId: sid });
    } catch {
      // 浏览器未就绪：证据为空即可
    }
    out.evidence = {
      navigated: joined.includes("127.0.0.1:19443") || joined.includes("Loopsoar E2E 本地页"),
      snapshotWithRefs: /快照 #\d+/.test(joined) && joined.includes("#e"),
      // 关键证据：真实鼠标事件（sendInputEvent）点中了页面按钮，页面文案随之变化。
      clickedMarker: joined.includes("按钮已点击"),
      userTabs,
      agentTabs,
    };
    out.ok =
      out.evidence.navigated &&
      out.evidence.snapshotWithRefs &&
      out.evidence.clickedMarker &&
      out.evidence.userTabs >= 1 &&
      out.evidence.agentTabs >= 1;
    return out;
  } catch (err) {
    return { ...out, error: err && err.message ? err.message : String(err) };
  }
})()