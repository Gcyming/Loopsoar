/**
 * Agent 接管锁脚本（Slice H）：锁定版必须在页面里画出可识别浮层、只拦真实用户事件；
 * 解锁版必须能解绑监听并删除宿主（否则「停止会话」后用户仍然点不动页面）。
 *
 * 这里只做静态断言：脚本最终跑在真实 Chromium 页面里，本仓库的 vitest 是 node 环境；
 * 行为级验证由 E2E（真机窗口）覆盖。
 */
import { describe, expect, it } from "vitest";
import { USER_LOCK_HOST_ATTR, buildUserLockScript } from "../../packages/shell/src/browserAdapter/refs.ts";

describe("buildUserLockScript", () => {
  it("锁定版：closed shadow root 浮层 + 固定 id/属性 + 最高层级与可拦事件", () => {
    const script = buildUserLockScript(true, "含<标签>&");
    expect(script.trim().startsWith("(() => {")).toBe(true);
    expect(script).toContain(USER_LOCK_HOST_ATTR);
    expect(script).toContain("loopsoar-user-lock");
    expect(script).toContain("attachShadow({ mode: 'closed' })");
    // 输入拦截靠 window capture，不靠遮罩抢命中：锁层 pointer-events:none，
    // 否则 elementFromPoint 会命中遮罩、:hover 会被夺走（坐标点击/悬浮菜单失效）。
    expect(script).toContain("position:fixed;inset:0;z-index:2147483647;pointer-events:none;");
    expect(script).not.toContain("pointer-events:auto");
    // 拦截列表必须覆盖鼠标/滚轮/键盘/输入/拖拽
    for (const type of ["pointerdown", "pointerup", "pointermove", "click", "wheel", "contextmenu", "keydown", "keyup", "beforeinput", "dragstart"]) {
      expect(script, `缺少事件 ${type}`).toContain(type);
    }
  });

  it("锁定版：只拦 isTrusted === true，放行 Agent 的合成事件", () => {
    const script = buildUserLockScript(true, "x");
    expect(script).toContain("event.isTrusted !== true");
    // 放行必须发生在 preventDefault 之前：合成事件直接 return，不被任何拦截逻辑碰到
    expect(script.indexOf("event.isTrusted !== true")).toBeLessThan(script.indexOf("preventDefault"));
    expect(script).toContain("stopImmediatePropagation");
    // capture 阶段抢先拦截（页面自身的监听先后顺序由此确定）
    expect(script).toContain("window.addEventListener(EVENTS[i], handler, true)");
  });

  it("锁定版：提示文案做 HTML 转义后再进 innerHTML", () => {
    const script = buildUserLockScript(true, "含<标签>&");
    expect(script).toContain("含&lt;标签&gt;&amp;");
    expect(script).not.toContain("含<标签>");
    // 引号同样转义：文案不能提前闭合属性/标签
    const quoted = buildUserLockScript(true, 'a"b');
    expect(quoted).toContain("a&quot;b");
    expect(quoted).not.toContain('"a"b"');
  });

  it("解锁版：解绑监听 + 删除宿主，且不再创建浮层", () => {
    const script = buildUserLockScript(false, "ignored");
    expect(script).toContain("removeEventListener");
    expect(script).toContain("removeChild");
    expect(script).toContain(USER_LOCK_HOST_ATTR);
    expect(script).toContain("loopsoar-user-lock");
    // 解锁只清理：不建 shadow root、不注册监听（否则会把刚解锁的页面重新锁住）
    expect(script).not.toContain("attachShadow");
    expect(script).not.toContain("addEventListener");
    expect(script).toContain("removed");
  });

  it("两次调用生成同一份脚本（幂等的前提：先清理旧状态）", () => {
    expect(buildUserLockScript(true, "a")).toBe(buildUserLockScript(true, "a"));
    // 两种形态都以「清旧状态」开头：重复注入不会叠加多层遮罩/泄漏监听
    expect(buildUserLockScript(true, "a")).toContain("typeof prev.handler === 'function'");
    expect(buildUserLockScript(false, "a")).toContain("typeof prev.handler === 'function'");
  });
});
