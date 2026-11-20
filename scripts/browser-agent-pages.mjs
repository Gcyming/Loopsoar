/**
 * 浏览器 Agent 任务级评测夹具页（只给评测脚本使用，不进产品构建）。
 *
 * 为什么不用公网页面：评测要可重复、可离线、断言确定；公网页面会漂移，
 * 而且登录墙/广告会把「工具是否可靠」与「站点是否友好」混在一起。
 * 每个路由对应 docs/BROWSER-AGENT-EVAL.md 里的一个任务面。
 *
 * 用法：node scripts/browser-agent-pages.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 19445);
const payState = { count: 0 };

const page = (title, body, script = "") => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;font-family:system-ui,'Microsoft YaHei';background:#0f172a;color:#e2e8f0;padding:24px}
  h1{font-size:24px;margin:0 0 12px} h2{font-size:18px}
  a{color:#7dd3fc} button,input,select{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}
  button{background:#0ea5e9;color:#06121f;font-weight:700;cursor:pointer;border:none}
  .row{display:flex;gap:10px;align-items:center;margin:10px 0}
  #results li,#order li{margin:6px 0}
  .modal{position:fixed;inset:0;background:rgba(2,6,23,.72);display:grid;place-items:center;z-index:50}
  .modal .box{background:#111827;border:1px solid #334155;border-radius:14px;padding:24px;min-width:280px;position:relative}
  .modal .close{position:absolute;top:8px;right:10px;background:transparent;color:#e2e8f0;font-size:18px}
  .menu{display:inline-block;position:relative;padding:10px 14px;background:#1e293b;border-radius:10px}
  .sub{display:none;position:absolute;top:100%;left:0;background:#1e293b;padding:8px;border-radius:10px;min-width:160px}
  .menu:hover .sub{display:block}
  .tall{height:1600px;background:linear-gradient(#0f172a,#1e293b)}
  #coord{position:fixed;left:100px;top:100px;width:120px;height:40px}
</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const routes = {
  "/": () => page("评测首页", `<h1>Loopsoar 浏览器评测夹具</h1><nav><a href="/search">搜索</a> · <a href="/form">表单</a></nav><main><p>选择任务路由开始。</p></main>`),
  "/search": () =>
    page(
      "搜索页",
      `<main><h1>搜索</h1>
      <form id="f"><div class="row"><input id="q" name="q" placeholder="关键词"><button id="go" type="submit">搜索</button></div></form>
      <ul id="results"></ul></main>`,
      `document.getElementById('f').addEventListener('submit', (e) => {
        e.preventDefault();
        const q = document.getElementById('q').value;
        document.getElementById('results').innerHTML =
          '<li>结果：' + q + '</li><li><a id="r2" href="/detail?n=2">第二条结果</a></li>';
      });`,
    ),
  "/detail": (url) => {
    const n = url.searchParams.get("n") ?? "1";
    return page(`详情 ${n}`, `<main><h1>详情 ${n}</h1><p>详情正文 ${n}</p><a id="back" href="/search">返回搜索</a></main>`);
  },
  "/nav": () => page("导航页", `<main><h1>导航页</h1><a id="to-detail" href="/detail?n=1">打开详情 1</a></main>`),
  "/form": () =>
    page(
      "表单页",
      `<main><h1>注册表单</h1>
      <form id="f">
        <div class="row"><input id="name" name="name" placeholder="姓名"></div>
        <div class="row"><input id="email" name="email" placeholder="邮箱"></div>
        <div class="row"><select id="size" name="size"><option value="S">小</option><option value="M">中</option><option value="L">大</option></select></div>
        <div class="row"><label><input type="checkbox" id="agree"> 同意条款</label></div>
        <button id="submit" type="submit">提交</button>
      </form>
      <div id="done"></div></main>`,
      `document.getElementById('f').addEventListener('submit', (e) => {
        e.preventDefault();
        document.getElementById('done').textContent = '提交成功：' + document.getElementById('name').value;
      });`,
    ),
  "/coords": () =>
    page(
      "坐标页",
      `<main><h1>坐标页</h1><button id="coord" onclick="document.getElementById('hit').textContent='COORD_OK'">坐标按钮</button>
      <div id="hit" style="margin-top:160px">未点击</div></main>`,
    ),
  "/pay": () =>
    page(
      "支付页",
      `<main><h1>订单</h1><p>订单金额 ¥ 99.00</p><button id="pay">立即支付</button><div id="paid" style="margin-top:14px">未支付</div></main>`,
      `document.getElementById('pay').addEventListener('click', async () => {
        try {
          await fetch('/api/pay', { method: 'POST' });
          document.getElementById('paid').textContent = '支付已提交';
        } catch (err) {
          document.getElementById('paid').textContent = '支付失败';
        }
      });`,
    ),
  "/select": () =>
    page(
      "选择页",
      `<main><h1>选项</h1>
      <div class="row"><select id="size"><option value="S">S</option><option value="M">M</option><option value="L">L</option></select></div>
      <div class="row"><label><input type="checkbox" id="agree"> 同意</label></div>
      <div id="state">state=</div></main>`,
      `const size = document.getElementById('size'); const agree = document.getElementById('agree');
      const sync = () => { document.getElementById('state').textContent = 'state=' + size.value + ';agree=' + agree.checked; };
      size.addEventListener('change', sync); agree.addEventListener('change', sync); sync();`,
    ),
  "/upload": () =>
    page(
      "上传页",
      `<main><h1>上传</h1><input type="file" id="file"><div id="uploaded">未上传</div></main>`,
      `document.getElementById('file').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        document.getElementById('uploaded').textContent = f ? ('已上传：' + f.name) : '未上传';
      });`,
    ),
  "/download": () =>
    page("下载页", `<main><h1>下载</h1><a id="dl" href="/files/report.txt" download="report.txt">下载报告</a></main>`),
  "/big": () => {
    const buttons = Array.from({ length: 100 }, (_, i) => `<button id="b${i + 1}">按钮 ${i + 1}</button>`).join("");
    return page(
      "大页面",
      `<header><h1>大页面</h1></header><nav><a href="/search">搜索</a></nav>
      <main><section>${buttons}</section></main><footer>页脚</footer>`,
    );
  },
  "/spa": () =>
    page(
      "SPA 页",
      `<main><h1>SPA 第一页</h1><button id="spa-go">去第二页</button><div id="spa-root"></div></main>`,
      `document.getElementById('spa-go').addEventListener('click', () => {
        history.pushState({ step: 2 }, '', '/spa?step=2');
        document.getElementById('spa-root').innerHTML = '<h1 id="spa-b">SPA 第二页</h1><button id="spa-back">返回</button>';
      });`,
    ),
  "/popup": () =>
    page(
      "弹窗页",
      `<main><h1>弹窗页</h1><p>正文可见</p></main>
      <div class="modal" id="modal"><div class="box"><button class="close" aria-label="关闭">×</button><h2>订阅提示</h2><p>关闭我才能继续操作。</p></div></div>`,
      `document.querySelector('#modal .close').addEventListener('click', () => { document.getElementById('modal').remove(); });`,
    ),
  "/list": () =>
    page(
      "长列表",
      `<main><h1>长列表</h1><ul id="items">${Array.from({ length: 60 }, (_, i) => `<li>ITEM-${i + 1}</li>`).join("")}</ul></main>
      <div class="tall"></div>`,
      `let loaded = false;
      window.addEventListener('scroll', () => {
        if (loaded) return;
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 40) {
          loaded = true;
          const li = document.createElement('li');
          li.textContent = 'ITEM-61';
          document.getElementById('items').appendChild(li);
        }
      });`,
    ),
  "/hover": () =>
    page(
      "悬停菜单",
      `<main><h1>悬停菜单</h1><div class="menu" id="menu">更多<div class="sub"><a id="sub" href="/detail?n=9">子项详情</a></div></div></main>`,
    ),
  "/drag": () =>
    page(
      "拖拽排序",
      `<main><h1>拖拽排序</h1><ul id="order"><li id="drag-source" style="padding:8px;background:#1e293b;margin:4px 0">A</li><li id="drop-target" style="padding:8px;background:#1e293b;margin:4px 0">B</li></ul>
      <div id="status">ORDER:A,B</div></main>`,
      `let dragging = false;
      const src = document.getElementById('drag-source');
      const dst = document.getElementById('drop-target');
      src.addEventListener('mousedown', () => { dragging = true; });
      dst.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        const ul = document.getElementById('order');
        ul.insertBefore(dst, src);
        document.getElementById('status').textContent = 'ORDER:B,A';
      });`,
    ),
  "/login": () =>
    page("登录页", `<main><h1>已登录</h1><p>会话保持测试</p></main>`),
  "/console": () =>
    page("控制台页", `<main><h1>控制台</h1><p>页面会报错</p></main>`, `console.error('BOOM: fixture error');`),
  "/net": () =>
    page(
      "网络页",
      `<main><h1>网络请求</h1><div id="net">等待请求</div></main>`,
      `fetch('/api/500').then((r) => { document.getElementById('net').textContent = 'HTTP ' + r.status; }).catch(() => { document.getElementById('net').textContent = '网络失败'; });`,
    ),
  "/slow": () =>
    page("慢页面", `<main><h1>慢页面</h1><div id="slow">LOADING</div></main>`, `setTimeout(() => { document.getElementById('slow').textContent = 'SLOW_READY'; }, 1200);`),
  "/tabs": () => page("标签页", `<main><h1>标签页</h1><p>用 browser_tabs 新开一个标签。</p></main>`),
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { "content-type": type, ...extra });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/pay" && req.method === "POST") {
    payState.count += 1;
    return send(res, 200, "application/json", JSON.stringify({ ok: true, count: payState.count }));
  }
  if (url.pathname === "/api/pay-count") {
    return send(res, 200, "application/json", JSON.stringify(payState));
  }
  if (url.pathname === "/api/reset") {
    payState.count = 0;
    return send(res, 200, "application/json", JSON.stringify({ ok: true }));
  }
  if (url.pathname === "/api/500") {
    return send(res, 500, "application/json", JSON.stringify({ error: "fixture 500" }));
  }
  if (url.pathname === "/files/report.txt") {
    return send(res, 200, "text/plain; charset=utf-8", "Loopsoar browser eval report\n", {
      "content-disposition": 'attachment; filename="report.txt"',
    });
  }

  const make = routes[url.pathname];
  if (!make) return send(res, 404, "text/plain; charset=utf-8", "not found");
  const extra = url.pathname === "/login" ? { "set-cookie": "sid=eval-session; Path=/; HttpOnly" } : {};
  send(res, 200, "text/html; charset=utf-8", make(url), extra);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Browser eval pages: http://127.0.0.1:${port}/`);
});
