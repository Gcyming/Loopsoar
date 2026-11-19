(async () => {
  // 六步链路真机验收（渲染层执行）：对话 → 模型 → 工具 → 权限确认 → 结果回核 → 记忆读写。
  // 由 scripts/e2e-six-step-run.mjs 注入；不进产品构建。
  const api = window.loopsoarAPI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: false, steps: [], evidence: {} };
  if (!api) return { error: "window.loopsoarAPI 不存在" };

  const historyText = async () => {
    try {
      const history = await api.chat.history();
      return (history?.session?.messages ?? []).map((m) => String(m.text ?? "")).join("\n");
    } catch {
      return "";
    }
  };
  const countToolDone = (text) => (text.match(/工具执行完成/g) ?? []).length;

  try {
    // 首次启动的欢迎层：先跳过，避免遮挡时间线与截图
    const skipBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "跳过");
    if (skipBtn) {
      skipBtn.click();
      await sleep(500);
    }

    const provider = await api.settings.upsertProvider({
      provider: "mock-six-step",
      baseUrl: "http://127.0.0.1:19502/v1",
      model: "mock-model",
      apiFormat: "openai",
    });
    const key = await api.settings.setApiKey({ apiKey: "sk-mock-six-step", providerId: provider?.item?.id });
    out.steps.push({ step: "provider", id: provider?.item?.id ?? null, keySaved: key?.saved ?? null });

    const created = await api.chat.newSession({});
    const sid = created?.session?.sessionId ?? null;
    out.sessionId = sid;
    if (!sid) return { ...out, error: "建会话失败" };

    // 第三/四步：权限判断必须真实发生（记录 perm:request）
    const permEvents = [];
    const offPerm = api.on("perm:request", (payload) => {
      permEvents.push({
        toolName: payload?.toolName ?? null,
        target: payload?.target ?? null,
        category: payload?.category ?? null,
        sessionId: payload?.sessionId ?? null,
      });
    });

    // 第一轮：对话 → 模型（mock）→ 工具 terminal_run（需确认）→ 结果回灌 → memory_add（需确认）
    const accepted = await api.chat.stream({
      message: "跑一条六步验收命令 echo six-step-ok，然后把这次验收结论记进长期记忆。",
      sessionId: sid,
      mode: "build",
    });
    out.steps.push({ step: "stream", accepted: accepted?.accepted ?? null });

    let dialogClicks = 0;
    const dialogTools = [];
    let turn1 = "";
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const overlay = document.querySelector(".permission-overlay");
      if (overlay) {
        const cardText = String(overlay.innerText || "").replace(/\s+/g, " ").trim();
        if (cardText && dialogTools.indexOf(cardText) === -1) dialogTools.push(cardText.slice(0, 160));
        const btn = Array.from(overlay.querySelectorAll("button")).find((b) => String(b.textContent || "").trim() === "允许一次");
        if (btn) {
          btn.click();
          dialogClicks += 1;
          await sleep(800);
          continue;
        }
      }
      turn1 = await historyText();
      if (countToolDone(turn1) >= 1 && dialogClicks >= 1) break;
      await sleep(400);
    }
    // 再等一小段，确保最终回答与工具结果都落库
    for (let i = 0; i < 40 && countToolDone(turn1) < 1; i += 1) {
      await sleep(500);
      turn1 = await historyText();
    }

    // 第六步：同一会话下一轮请求必须带出上轮写入的记忆（mock 侧用 MOCK_PROBE 记录是否见到）
    const accepted2 = await api.chat.stream({
      message: "上次那条六步验收记录里，我用的是什么命令？",
      sessionId: sid,
      mode: "build",
    });
    let turn2 = turn1;
    for (let i = 0; i < 120; i += 1) {
      turn2 = await historyText();
      // 第二轮 mock 走纯文本分支（REPLY_CHUNKS 首句），用它判断第二轮已完成。
      if (turn2.indexOf("本地模拟模型") !== -1) break;
      await sleep(500);
    }
    offPerm?.();

    let facts = [];
    try {
      const memory = await api.memory.list();
      facts = memory?.facts ?? [];
    } catch (err) {
      out.memoryError = err && err.message ? err.message : String(err);
    }
    const savedFact = facts.find((fact) => String(fact.content).includes("SIXSTEP-MEMO-19452")) ?? null;

    out.evidence = {
      permissionRequested: permEvents.length > 0,
      permissionTools: permEvents.map((item) => item.toolName),
      permissionAnsweredByClick: dialogClicks >= 1,
      dialogClicks,
      dialogTools,
      toolExecuted: turn1.indexOf("six-step-ok") !== -1,
      memoryToolResult: turn1.indexOf("已记住记忆") !== -1,
      resultFedBack: countToolDone(turn1) >= 1,
      memorySaved: Boolean(savedFact),
      memoryContent: savedFact ? String(savedFact.content).slice(0, 160) : null,
      secondTurnDone: turn2.indexOf("本地模拟模型") !== -1,
      historyTail: turn2.slice(-700),
      domProbe: {
        bodyText: String(document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
        overlays: document.querySelectorAll(".permission-overlay").length,
      },
    };
    out.ok = Boolean(
      out.evidence.permissionRequested &&
        out.evidence.permissionAnsweredByClick &&
        out.evidence.toolExecuted &&
        out.evidence.memoryToolResult &&
        out.evidence.resultFedBack &&
        out.evidence.memorySaved &&
        out.evidence.secondTurnDone,
    );
    return out;
  } catch (err) {
    return { ...out, error: err && err.message ? err.message : String(err) };
  }
})()