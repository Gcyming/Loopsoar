/**
 * D0 决策门最小验证（P0-验证计划 W1）：
 * WebContentsView 路线走通 导航 → 元素编号 → 点击 → 输入 → 滚动 → 截图 → JS 注入。
 * 运行：npx electron packages/shell/dev/d0-probe/main.cjs
 * 为什么独立于主应用：D0 只验证技术路线可行性，不引入产品逻辑；
 * 真实第三方站点（登录页、弹窗、下载）由用户后续手动过一遍。
 */
const { app, BaseWindow, WebContentsView } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>D0 Probe</title></head>
<body style="font-family: sans-serif; padding: 24px;">
  <h1>Loopsoar D0 Probe</h1>
  <input id="name" placeholder="输入姓名" />
  <button id="btn" onclick="document.getElementById('out').textContent='点击成功'">点我</button>
  <p id="out">未点击</p>
  <div style="height: 3000px;"></div>
  <p id="bottom">页面底部</p>
</body></html>`)}`;

const MARK = `(() => {
  let i = 0;
  const nodes = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[onclick]');
  nodes.forEach((el) => el.setAttribute('data-loops-el', String(i++)));
  return nodes.length;
})()`;

async function main() {
  const results = {};
  // show: true —— capturePage 在隐藏窗口上可能返回空图，D0 需要真实像素证据
  const win = new BaseWindow({ width: 960, height: 720, show: true, title: "Loopsoar D0 Probe" });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 960, height: 720 });
  const wc = view.webContents;

  const domReady = new Promise((r) => wc.on("dom-ready", () => r()));
  await wc.loadURL(PAGE);
  await Promise.race([domReady, new Promise((r) => setTimeout(r, 8000))]);
  await new Promise((r) => setTimeout(r, 200));
  results.loaded = String(wc.getURL()).startsWith("data:");

  // ① 元素编号（快照基础）
  results.markedElements = await wc.executeJavaScript(MARK, false);

  // ② 快照（元素列表）
  const snap = await wc.executeJavaScript(
    `(() => ({
      title: document.title,
      els: Array.from(document.querySelectorAll('[data-loops-el]')).map((el) => ({
        id: el.getAttribute('data-loops-el'),
        tag: el.tagName.toLowerCase(),
      })),
    }))()`,
    false,
  );
  results.title = snap.title;
  results.elementList = snap.els;

  // ③ 点击（按编号）→ 断言 DOM 变化
  await wc.executeJavaScript(`document.querySelector('[data-loops-el="1"]').click(); true`, true);
  results.clickResult = await wc.executeJavaScript(`document.getElementById('out').textContent`, false);

  // ④ 输入（React 兼容 setter + input/change 事件）
  await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-loops-el="0"]');
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, 'Loopsoar'); else el.value = 'Loopsoar';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    true,
  );
  results.inputValue = await wc.executeJavaScript(
    `document.querySelector('[data-loops-el="0"]').value`,
    false,
  );

  // ⑤ 滚动
  await wc.executeJavaScript(`window.scrollTo(0, 1200); true`, true);
  await new Promise((r) => setTimeout(r, 120));
  results.scrollY = await wc.executeJavaScript(`window.scrollY`, false);

  // ⑥ 截图（真实像素证据）
  const image = await wc.capturePage();
  const png = image.toPNG();
  const outPath = path.join(__dirname, "shot.png");
  fs.writeFileSync(outPath, png);
  results.screenshotBytes = png.length;
  results.screenshotPath = outPath;

  // ⑦ JS 注入
  results.jsInjected = await wc.executeJavaScript(
    `(() => ({ sum: 1 + 2, hasBottom: !!document.getElementById('bottom') }))()`,
    true,
  );

  win.destroy();

  const ok =
    results.loaded === true &&
    results.markedElements >= 2 &&
    results.clickResult === "点击成功" &&
    results.inputValue === "Loopsoar" &&
    results.scrollY > 0 &&
    results.screenshotBytes > 1000 &&
    results.jsInjected &&
    results.jsInjected.sum === 3;
  console.log("D0_RESULT " + JSON.stringify({ ok, ...results }, null, 2));
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error("D0_FAILED", err && err.stack ? err.stack : err);
  app.exit(2);
});
