/**
 * 页面接管锁 + Agent 真实输入放行（从 refs.ts 拆出：单一职责，避免 refs 撞 1500 行红线）。
 *
 * 锁用 window capture 拦截真实用户事件；宿主/遮罩始终 pointer-events:none，
 * 否则会夺走 Agent 鼠标的 elementFromPoint 与 :hover。
 */

/**
 * 接管锁浮层的宿主属性：注入到页面 DOM 上时唯一可识别的标记
 * （closed shadow root 内部页面拿不到，宿主节点是唯一可检测/可清理的锚点）。
 */
export const USER_LOCK_HOST_ATTR = "data-loopsoar-lock";

/** 浮层宿主 id（固定值：解锁时即使 window 状态丢了也能按 id 清掉残留节点）。 */
export const USER_LOCK_HOST_ID = "loopsoar-user-lock";

/**
 * target-point 的页面内滚动等待片段。
 * 后台标签/隐藏 WebContents 的 requestAnimationFrame 可能永远不触发（窗口最小化、
 * 任务标签未可见、切换会话后视图被 detach）；这里必须有超时兜底，否则定位脚本会把
 * 整个工具调用挂到任务超时。隐藏文档直接跳过动画等待，坐标仍由同步布局计算。
 */
export const TARGET_POINT_SCROLL_JS = `  const waitFrame = () => new Promise((resolve) => {
    if (document.visibilityState === 'hidden') { resolve(); return; }
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 100);
  });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  await waitFrame();
  let prev = null;
  for (let i = 0; i < 3; i += 1) { const now = JSON.stringify(el.getBoundingClientRect()); if (now === prev) break; prev = now; await waitFrame(); }`;

/** 浮层拦截的事件类型：覆盖鼠标/滚轮/键盘/输入/拖拽，全部在 capture 阶段抢先处理。 */
const USER_LOCK_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "click",
  "wheel",
  "contextmenu",
  "keydown",
  "keyup",
  "beforeinput",
  "dragstart",
];

/** 浮层文案的 HTML 转义（label 来自 i18n，仍按不可信输入处理：它最终进 innerHTML）。 */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 页面内公共前导：解绑旧监听 + 删除旧宿主。
 * 为什么先清旧的：Agent 反复锁定/解锁、或页面把浮层节点搬走时，
 * 只有「先删再建」才能保证重复调用幂等（不会叠加多层遮罩、不会泄漏监听）。
 */
function userLockPreambleJs(): string {
  return `  const KEY = '__loopsoarUserLock';
  const HOST_ID = ${JSON.stringify(USER_LOCK_HOST_ID)};
  const ATTR = ${JSON.stringify(USER_LOCK_HOST_ATTR)};
  const EVENTS = ${JSON.stringify(USER_LOCK_EVENTS)};
  const doc = document;
  const prev = window[KEY];
  if (prev && typeof prev.handler === 'function') {
    for (let i = 0; i < EVENTS.length; i += 1) {
      try { window.removeEventListener(EVENTS[i], prev.handler, true); } catch (err) {}
    }
  }
  try { delete window[KEY]; } catch (err) { window[KEY] = null; }
  // 宿主节点可能因页面重渲染或异常中断残留：按 id 或属性都能找到并清掉。
  const stale = doc.getElementById(HOST_ID) || doc.querySelector('[' + ATTR + ']');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);`;
}

/**
 * Agent 接管锁脚本（会话运行期间浮在当前网页上，阻止用户操作该页面）。
 *
 * 关键约束：只拦 **isTrusted === true** 且非 Agent 派发的真实用户事件
 * （window.__loopsoarAgentDriving 由 buildAgentDrivingScript 置位）。
 *   · 合成事件（el.click() / dispatchEvent）的 isTrusted 一定是 false：
 *     它们同样会经过捕获阶段，若无条件拦截，Agent 会把自己的动作一起锁死；
 *   · 监听挂在 window 的 capture 阶段：比页面自己的 document 监听更早，
 *     页面里注册的 handler 收不到事件（stopImmediatePropagation 连同一节点上的后续监听也停掉）。
 *
 * locked=false 时只做清理（解绑 + 删宿主），不建浮层：解锁必须能救回一个「锁坏了」的页面。
 */
export function buildUserLockScript(locked: boolean, label: string): string {
  if (!locked) {
    return `(() => {
${userLockPreambleJs()}
  return { ok: true, locked: false, removed: Boolean(prev || stale) };
})()`;
  }
  // 文案先转义再放进 innerHTML：closed shadow root 里没有其它注入面，转义后即可安全插入。
  const safeLabel = escapeHtmlText(label);
  return `(() => {
${userLockPreambleJs()}
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute(ATTR, 'active');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
  // 只做「透明输入拦截层」：不再给整页压暗（用户要求：运行期用网页四周的呼吸灯表达，
  // 而不是把页面变暗）。层本身不画任何背景；用户输入由 window capture 监听拦截，
  // 这里保持 pointer-events:none，避免夺走 Agent 鼠标的 :hover / elementFromPoint。
  const mask = doc.createElement('div');
  mask.style.cssText = 'position:absolute;inset:0;background:transparent;pointer-events:none;display:flex;align-items:flex-start;justify-content:center;';
  // 提示文案：无边框无底色块，中心（文字处）最实、向四周均匀渐隐（用户指定的渲染样式）。
  const hint = doc.createElement('div');
  // 与全局提示统一：胶囊圆角 + 中灰微透 + 轻投影（用户 m02333：所有提示类浮窗写死这一套）。
  hint.style.cssText = 'margin-top:44px;max-width:min(620px,88vw);padding:14px 30px;color:#f7f2e8;font:500 13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;background:rgba(64,68,76,.86);border-radius:999px;border:0;box-shadow:0 6px 22px rgba(0,0,0,.35);text-shadow:0 1px 2px rgba(0,0,0,.55);pointer-events:none;';
  hint.innerHTML = ${JSON.stringify(safeLabel)};
  mask.appendChild(hint);
  root.appendChild(mask);
  (doc.documentElement || doc.body || doc).appendChild(host);
  const handler = (event) => {
    if (!event || event.isTrusted !== true) return;
    // Agent 正在派发真实输入（webContents.sendInputEvent）时放行：它同样 isTrusted=true，
    // 但语义上是「Loopsoar 自己的鼠标」，不是用户在抢操作。标志由主进程在派发前置位。
    if (window.__loopsoarAgentDriving === true) return;
    try { event.preventDefault(); } catch (err) {}
    try { event.stopImmediatePropagation(); } catch (err) {}
  };
  for (let i = 0; i < EVENTS.length; i += 1) {
    // capture=true：抢在页面自身的监听之前把真实用户输入拦下。
    window.addEventListener(EVENTS[i], handler, true);
  }
  // mask 也要记住：放行真实输入时它必须 pointer-events:none，否则点击打在遮罩上到不了页面。
  window[KEY] = { host: host, mask: mask, handler: handler };
  return { ok: true, locked: true };
})()`;
}

/**
 * Agent 真实输入放行开关：页面接管锁只拦 isTrusted 事件，而 sendInputEvent 产生的正是
 * trusted 事件——必须在派发前置位，否则锁会把 Agent 自己的点击吞掉。
 * 同时把锁的宿主/遮罩设为 pointer-events:none，否则真实点击会打在遮罩上到不了页面。
 */
export function buildAgentDrivingScript(on: boolean): string {
  return `(() => {
  window.__loopsoarAgentDriving = ${on ? "true" : "false"};
  // 锁层始终 pointer-events:none：用户输入由 window capture 监听拦截，
  // 不再靠遮罩抢命中。否则 mouseMove 一恢复遮罩就会夺走 :hover，悬浮菜单/坐标探测都会失效。
  const lock = window.__loopsoarUserLock;
  if (lock) {
    if (lock.host) lock.host.style.pointerEvents = 'none';
    if (lock.mask) lock.mask.style.pointerEvents = 'none';
  }
  return true;
})()`;
}
