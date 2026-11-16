(async () => {
  // 敏感确认端到端（渲染层执行）：配 mock 供应商 → 建会话开「浏览器控制」→
  // mock 依次要求 navigate / snapshot / click(立即支付) → 等敏感确认弹窗 → 用界面按钮真实点「确认执行」→ 取证。
  const api = window.loopsoarAPI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: false, steps: [] };
  if (!api) return { error: "window.loopsoarAPI 不存在" };
  try {
    const skipBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "跳过");
    if (skipBtn) {
      skipBtn.click();
      await sleep(500);
    }

    const provider = await api.settings.upsertProvider({
      provider: "mock-confirm",
      baseUrl: "http://127.0.0.1:19501/v1",
      model: "mock-model",
      apiFormat: "openai",
    });
    await api.settings.setApiKey({ apiKey: "sk-mock-confirm", providerId: provider?.item?.id });

    // 用「当前会话」而不是新建：渲染层的 currentSession 是本地状态，新建的会话不会自动切过去，
    // 询问会按会话路由到「其它会话待确认」，测不到弹窗本身。
    const list = await api.chat.sessions();
    const sid = list?.currentId ?? list?.sessions?.[0]?.sessionId ?? null;
    out.sessionId = sid;
    if (!sid) return { ...out, error: "拿不到当前会话" };
    await api.chat.setBrowserControl({ sessionId: sid, enabled: true });

    // 监听 ask:user：记录敏感确认负载（会话归属 / 语义 / 上下文 / 到期时刻）
    let askPayload = null;
    const off = api.on("ask:user", (payload) => {
      if (payload && payload.kind === "sensitive") {
        askPayload = {
          kind: payload.kind,
          sessionId: payload.sessionId ?? null,
          title: payload.title ?? null,
          detail: payload.detail ?? [],
          expiresAt: payload.expiresAt ?? null,
          options: payload.options ?? [],
        };
      }
    });

    // 先像用户一样打开页面：Agent 首次动作为克隆，原页保留
    const opened = await api.browser.navigate({ url: "http://127.0.0.1:19444/" });
    out.steps.push({ step: "userTab", ok: opened?.ok ?? null });

    const accepted = await api.chat.stream({
      message: "打开 http://127.0.0.1:19444/ ，点击「立即支付」按钮，然后告诉我结果",
      sessionId: sid,
      mode: "build",
    });
    out.steps.push({ step: "stream", accepted: accepted?.accepted ?? null });

    // 等敏感确认弹窗（DOM 真值，不靠 sleep 猜）；同时观察「其它会话待确认」胶囊
    let dialog = null;
    let pillSeen = false;
    let pillClicked = false;
    let permSeen = false;
    let permAnswered = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      // 第一道：权限确认（browser_click 的类别策略默认「询问」）——真实点「允许一次」
      if (!permAnswered) {
        const permBtn = Array.from(document.querySelectorAll(".permission-overlay button")).find(
          (b) => String(b.textContent || "").trim() === "允许一次",
        );
        if (permBtn) {
          permSeen = true;
          permBtn.click();
          permAnswered = true;
          await sleep(500);
        }
      }
      if (!pillClicked) {
        const pill = document.querySelector(".ask-pending-other");
        if (pill) {
          pillSeen = true;
          // 会话归属不一致时先点「前往」，验证胶囊 → 切会话 → 弹窗这条真实路径
          pill.click();
          pillClicked = true;
          await sleep(600);
        }
      }
      const el = document.querySelector('[data-kind="sensitive"]');
      if (el) {
        const text = (sel) => {
          const node = el.querySelector(sel);
          return node ? String(node.textContent || "").trim() : "";
        };
        dialog = {
          kind: el.getAttribute("data-kind"),
          title: text(".ask-title"),
          question: text(".ask-question"),
          detail: Array.from(el.querySelectorAll(".ask-detail-row")).map((row) => ({
            label: (row.querySelector(".ask-detail-label")?.textContent || "").trim(),
            value: (row.querySelector(".ask-detail-value")?.textContent || "").trim(),
          })),
          buttons: Array.from(el.querySelectorAll("button")).map((b) => String(b.textContent || "").trim()),
          countdown: text(".ask-countdown"),
        };
        break;
      }
      await sleep(200);
    }
    out.dialog = dialog;
    out.dialogSeen = Boolean(dialog);
    out.pillSeen = pillSeen;
    out.pillClicked = pillClicked;
    out.permSeen = permSeen;
    out.permAnswered = permAnswered;
    // 现场取证：即使选择器没命中，也能看出界面上到底有什么（弹窗/胶囊/其它模态）
    out.domProbe = {
      askOverlays: document.querySelectorAll(".ask-overlay").length,
      dialogs: Array.from(document.querySelectorAll(".ask-dialog")).map((el) => el.getAttribute("data-kind")),
      pills: document.querySelectorAll(".ask-pending-other").length,
      bodyText: String(document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
    };

    if (dialog) {
      // 给主进程截图钩子（LOOPSOAR_E2E_CONFIRM_SHOT）留出抓帧时间
      await sleep(2500);
      const confirmBtn = Array.from(document.querySelectorAll('[data-kind="sensitive"] button')).find(
        (b) => String(b.textContent || "").trim() === "确认执行",
      );
      if (confirmBtn) {
        confirmBtn.click();
        out.confirmedByClick = true;
      } else {
        out.confirmedByClick = false;
      }
    }

    await sleep(9000);
    off?.();

    let snapText = "";
    try {
      const snap = await api.browser.snapshot();
      snapText = String(snap?.text ?? "");
    } catch (err) {
      out.snapshotError = err && err.message ? err.message : String(err);
    }

    let history = null;
    try {
      history = await api.chat.history();
    } catch (err) {
      out.historyError = err && err.message ? err.message : String(err);
    }
    const joined = (history?.session?.messages ?? []).map((m) => String(m.text ?? "")).join("\n");
    out.historyText = joined.slice(-700);
    out.pageText = snapText.slice(0, 200);
    out.askPayload = askPayload;

    out.evidence = {
      dialogSeen: out.dialogSeen,
      pillSeen: out.pillSeen,
      pillClicked: out.pillClicked,
      permissionAnswered: out.permAnswered,
      dialogTitle: dialog ? dialog.title : null,
      detailLabels: dialog ? dialog.detail.map((row) => row.label) : [],
      hasPaymentReason: dialog ? dialog.detail.some((row) => String(row.value).includes("支付")) : false,
      sawCountdown: dialog ? /\d/.test(dialog.countdown || "") : false,
      confirmedByClick: Boolean(out.confirmedByClick),
      pageSaysPaid: snapText.includes("支付已提交"),
      deniedBeforeConfirm: joined.includes("SENSITIVE_DENIED"),
      askCarriesSession: Boolean(askPayload && askPayload.sessionId === sid),
      askHasExpiry: Boolean(askPayload && typeof askPayload.expiresAt === "number"),
    };
    out.ok = Boolean(
      out.dialogSeen &&
        out.confirmedByClick &&
        out.evidence.hasPaymentReason &&
        out.evidence.pageSaysPaid &&
        !out.evidence.deniedBeforeConfirm &&
        out.evidence.askCarriesSession &&
        out.evidence.askHasExpiry,
    );
    return out;
  } catch (err) {
    return { ...out, error: err && err.message ? err.message : String(err) };
  }
})()
