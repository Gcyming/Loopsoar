/**
 * 浏览器「动手」工具：点击、输入、按键、选择、拖拽、悬停、滚动、关弹窗。
 *
 * 拆分自 browserTools.ts（行为与文案不变）。这一族的共同点：动作前必须把 ref 解析成
 * 一个真实元素或坐标，动作后必须给状态增量；因此都走 bindRefToTab + settleTab 同一套路。
 */
import { z } from "zod";
import { classifySensitiveStep } from "loopsoar-core/sensitiveSteps";
import type { ToolResult } from "loopsoar-core/tools/registry";
import { pointMissMessage } from "../browserFormat.js";
import {
  NAMED_KEYS,
  buildDismissOverlayScript,
  buildFocusProbeScript,
  isSupportedKey,
  performClick,
  performFocus,
  performFocusCheck,
  performHover,
  performPressKey,
  performSelect,
  performTargetPoint,
  performType,
  performTypeReadback,
  type RefRegistry,
  type TargetPointResult,
} from "../../browserAdapter/refs.js";
import { performPointClick, performPointProbe, type PointProbeResult } from "../browserPoint.js";
import {
  BrowserClickSchema,
  activeTabOf,
  bindRefToTab,
  describeFocusProbe,
  readTab,
  sensitiveClickReason,
  settleTab,
  statusLine,
  type BrowserToolEnv,
} from "./context.js";

/** 注册交互类浏览器工具。 */
export function registerInteractTools(env: BrowserToolEnv): void {
  env.register({
    name: "browser_click",
    description:
      "点击页面元素（真实鼠标事件，像用户一样移动光标并按下去）：优先用快照里的 #eN（如 e5 或 5），也支持 CSS 选择器或 'text=登录'。视觉定位后可直接传视口坐标 x/y（CSS 像素；若截图按设备像素渲染，传 space='image' 按 DPR 换算）。点前做命中验证（被浮层遮挡返回 BLOCKED_BY_OVERLAY），点后返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: BrowserClickSchema,
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const parsed = BrowserClickSchema.safeParse(ctx.params ?? {});
        if (!parsed.success) {
          const detail = parsed.error.issues.map((issue) => issue.message).join("；");
          return { ok: false, content: `[INVALID_ARGS] ${detail}` };
        }
        const { target, space = "css" } = parsed.data;
        const x = parsed.data.x;
        const y = parsed.data.y;
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const before = readTab(host, ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        let registry: RefRegistry | null = null;
        let point: TargetPointResult | PointProbeResult;
        let autoDismissed: string | null = null;

        if (target) {
          // 跨标签保护：ref 只对「产生它的标签」有效
          const binding = bindRefToTab(env.bindings, ctx.sessionId, tabId, target);
          if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
          registry = env.bindings.registry(ctx.sessionId, tabId);
          // 第一步只定位（不点击）：拿到目标中心坐标，覆盖层才能把「Agent 的鼠标」移过去。
          // 解析、命中验证与错误文案仍由 refs.ts 单源提供（和旧点击路径同一套）。
          point = await performTargetPoint(registry, target, run);
          // 被登录/引导弹窗挡住时先自己关掉再重试一次：模型常常只会「换个页面继续」，不会处理弹窗。
          if (!point.ok && point.code === "BLOCKED_BY_OVERLAY") {
            const dismissed = (await host
              .executeScript(buildDismissOverlayScript(), ctx.sessionId, tabId ?? undefined)
              .catch(() => null)) as { ok?: boolean; action?: string } | null;
            if (dismissed?.ok) {
              autoDismissed = dismissed.action ?? "dismiss";
              await new Promise((resolve) => setTimeout(resolve, 260));
              point = await performTargetPoint(registry, target, run);
            }
          }
        } else {
          // 视觉坐标路径：先探测命中的真实元素，不直接对像素空点派发点击。
          point = await performPointProbe(run, x ?? 0, y ?? 0, space);
        }

        if (!point.ok || typeof point.x !== "number" || typeof point.y !== "number") {
          const code = point.code ?? "NO_TARGET";
          return { ok: false, content: `[${code}] ${point.message ?? (target ? `点击失败：${target}` : "坐标点击失败")}` };
        }
        // 坐标路径的「空白」判定：探测命中了元素，但它既没有文案也不可交互（页面留白/装饰层），
        // 此时派发真实点击只会点空。明确报 NO_TARGET，而不是假装点成功了。
        if (!target) {
          const miss = pointMissMessage(point);
          if (miss) return { ok: false, content: miss };
        }

        // 敏感步骤：策略层只能看到 target（多为 #e12），必须等定位拿到真实文案后再判一次。
        // 坐标路径没有 target，同样用 elementFromPoint 读到的文案做二次确认。
        // 判定放在「移动光标之前」：被拒绝时不留下任何动作痕迹，也不产生涟漪/点击。
        //
        // 去重：`text=立即支付` 这类把敏感词写在 target 里的调用，策略层（services/chat.ts 的
        // 敏感步骤升级）已经弹过一次确认；这里只在「target 看不出语义、label 才判得出」时补一次，
        // 避免同一次点击连弹两个窗（第一次是权限、第二次是敏感）。
        const pointLabel = "label" in point ? point.label ?? "" : "";
        const targetText = point.text ?? pointLabel;
        const sensitive = sensitiveClickReason(target ?? "", "")
          ? null
          : sensitiveClickReason(target ?? "", targetText);
        if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
          console.log("[browser-click] sensitive", JSON.stringify({ target: target ?? null, x: point.x, y: point.y, text: point.text ?? null, label: pointLabel, sensitive }));
        }
        const label = targetText.trim() || pointLabel.trim() || target || `坐标 (${point.x},${point.y})`;
        if (sensitive) {
          let allowed = false;
          if (env.hooks?.confirmSensitive) {
            try {
              allowed = await env.hooks.confirmSensitive({
                sessionId: ctx.sessionId,
                tool: "browser_click",
                label,
                reason: sensitive,
                ...(before?.url ? { url: before.url } : {}),
              });
            } catch {
              allowed = false;
            }
          }
          if (!allowed) {
            return {
              ok: false,
              content: `[SENSITIVE_DENIED] 已拦截敏感点击「${label}」：${sensitive}。未执行点击；如确需执行，请在界面上确认`,
            };
          }
        }

        // 第二步：光标移动 + 高亮 + 涟漪（视觉在覆盖层，网页本身不被注入任何节点）。
        const shown = env.pointPointer(host, ctx.sessionId, tabId, {
          x: point.x,
          y: point.y,
          width: point.width,
          height: point.height,
        });
        if (shown) {
          // 留出移动补间时间（覆盖层最长 260ms）：用户能看清「鼠标滑过去再点」，而不是瞬移。
          await new Promise((resolve) => setTimeout(resolve, 280));
          if (target) {
            // 光标滑行期间页面可能因动画/图片/字体变化移动：点击前重新测一次，避免点错。
            const refreshed = await performTargetPoint(registry, target, run, { scrollIntoView: false });
            if (!refreshed.ok || typeof refreshed.x !== "number" || typeof refreshed.y !== "number") {
              return { ok: false, content: refreshed.message ?? "[TARGET_MOVED] 目标位置在光标移动期间发生变化，请重新快照" };
            }
            point = refreshed;
          } else {
            // 坐标路径没有可重新解析的 target；用同坐标复测，若元素已换人则要求重新截图，避免误点。
            // 注意：点探测返回的 x/y 已是 CSS 视口坐标，复测必须按 css 空间，不能再按 image 除一次 DPR。
            const refreshed = await performPointProbe(run, point.x, point.y, "css");
            if (!refreshed.ok || typeof refreshed.x !== "number" || typeof refreshed.y !== "number") {
              return { ok: false, content: `[${refreshed.code ?? "TARGET_MOVED"}] ${refreshed.message ?? "坐标处目标已消失，请重新截图"}` };
            }
            if ((refreshed.tag ?? "") !== (point.tag ?? "") || (refreshed.text ?? "") !== (point.text ?? "")) {
              return { ok: false, content: "[TARGET_MOVED] 坐标处的元素在光标移动期间发生变化，请重新截图后再点击" };
            }
            point = refreshed;
          }
          if (typeof point.x !== "number" || typeof point.y !== "number") {
            return { ok: false, content: "[TARGET_MOVED] 目标位置无效，请重新快照" };
          }
          shown.pointer.click(point.x, point.y);
        }

        // 第三步：真实鼠标事件（sendInputEvent）。假视图/旧后端不支持时回退到脚本点击。
        const clickX = point.x;
        const clickY = point.y;
        if (typeof clickX !== "number" || typeof clickY !== "number") {
          return { ok: false, content: "[TARGET_MOVED] 目标位置无效，请重新快照" };
        }
        const real = typeof host.agentClick === "function"
          ? await host.agentClick(ctx.sessionId, tabId ?? undefined, { x: clickX, y: clickY })
          : false;
        if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
          console.log("[browser-click]", JSON.stringify({ ok: point.ok, code: point.code, x: clickX, y: clickY, real, target: target ?? null }));
        }
        let degraded = false;
        if (!real) {
          const fallback = target
            ? await performClick(registry, target, run)
            : await performPointClick(run, clickX, clickY, "css");
          if (!fallback.ok) {
            return { ok: false, content: `[CLICK_FAILED] ${fallback.message ?? (target ? `点击失败：${target}` : "坐标点击失败")}` };
          }
          degraded = true;
        }
        env.fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const notes = ["投递=delivered_unverified（retry=unsafe）"];
        if (autoDismissed) notes.unshift(`已自动关闭遮挡弹窗：${autoDismissed}`);
        if (degraded) notes.unshift("视图不可用，已降级为脚本点击");
        return { ok: true, content: statusLine(`已点击 ${label}`, settled) + `（${notes.join("；")}）` };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_dismiss_popup",
    description:
      "关闭当前页面上的遮挡弹窗（登录/引导/广告/公告层）：按「关闭/×/Esc」启发式处理并返回做了什么。点击被 BLOCKED_BY_OVERLAY 时也可直接调用",
    permissions: { browser: true },
    schema: z.object({}),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const host = env.needHost();
        const tabs = host.listTabs(ctx.sessionId);
        if (tabs.length === 0) return { ok: false, content: "[NO_TAB] 当前会话没有打开的网页标签" };
        const tabId = activeTabOf(host, ctx.sessionId);
        let result: { ok?: boolean; action?: string; code?: string } | null = null;
        try {
          result = (await host.executeScript(
            buildDismissOverlayScript(),
            ctx.sessionId,
            tabId ?? undefined,
          )) as { ok?: boolean; action?: string; code?: string } | null;
        } catch (err) {
          return { ok: false, content: `[SCRIPT_ERROR] 页面脚本执行失败：${err instanceof Error ? err.message : String(err)}` };
        }
        if (!result?.ok) {
          // 没找到关闭控件：已按 Esc 尝试，但必须如实告诉模型「无可操作控件」而不是假成功。
          return {
            ok: false,
            content: `[NOTHING_FOUND] 没有找到明确的关闭控件；已发送 Esc 尝试关闭。可先 browser_snapshot 查看页面再决定（${result?.action ?? "escape"}）`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
        return { ok: true, content: `已关闭遮挡弹窗（${result.action ?? "dismiss"}）；如需继续操作请重新 browser_snapshot 获取最新状态` };
      } catch (err) {
        return { ok: false, content: `[错误] 关闭弹窗失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_type",
    description:
      "在输入框输入文本：优先用快照里的 #eN（如 e2），也支持 CSS 选择器；会像用户一样点进输入框、全选后逐字敲键盘（CJK 经输入法上屏），回读校验不通过时回退原生 setter；返回地址/标题/加载态状态行",
    permissions: { browser: true },
    schema: z.object({ target: z.string().min(1).max(500), text: z.string().max(4000) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = ctx.params as { target?: string; text?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(env.bindings, ctx.sessionId, tabId, params.target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = env.bindings.registry(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        const text = params.text ?? "";
        // 视觉：光标移到输入框 + 键盘胶囊（真实键盘输入时用户能看到「光标停在输入框上」）。
        let point = await performTargetPoint(registry, params.target, run);
        const shown = point.ok && typeof point.x === "number" && typeof point.y === "number"
          ? env.pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height })
          : null;
        if (shown) {
          shown.pointer.chip("⌨ 输入中");
          // 等光标滑到位再开始敲键盘（输入本身是即时注入，视觉上要同步）。
          await new Promise((resolve) => setTimeout(resolve, 240));
          const refreshed = await performTargetPoint(registry, params.target, run, { scrollIntoView: false });
          if (refreshed.ok && typeof refreshed.x === "number" && typeof refreshed.y === "number") point = refreshed;
        }
        // 真实键盘优先：点进输入框 → Ctrl+A → 逐字输入 → 回读校验。
        // 不成立（不支持 sendInputEvent / 受控组件拒收 / 非文本元素）时回退原生 setter。
        let result: Awaited<ReturnType<typeof performType>> | null = null;
        let formatNote = "";
        if (point.ok && point.editable === true && typeof point.x === "number" && typeof point.y === "number") {
          const focused = await host.agentClick(ctx.sessionId, tabId ?? undefined, { x: point.x, y: point.y });
          if (focused) {
            const focus = await performFocusCheck(registry, params.target, run);
            if (!focus.ok) return { ok: false, content: focus.message ?? "[FOCUS_MISMATCH] 焦点不在目标输入框" };
          }
          const typed = focused && typeof host.agentType === "function"
            ? await host.agentType(ctx.sessionId, tabId ?? undefined, text, { multiline: point.multiline === true })
            : false;
          if (typed) {
            const expected = point.multiline === true
              ? text.replace(/\r\n?/g, "\n")
              : text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
            // 输入事件是异步到达渲染进程的：轮询回读，别在按键还没上屏时抢占结论。
            for (let attempt = 0; attempt < 12; attempt += 1) {
              const read = await performTypeReadback(registry, params.target, run);
              if (read.ok && read.value === expected) {
                result = { ok: true, label: point.label ?? params.target };
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
            if (!result) {
              // maxlength 截断、受控组件大写/去空格、contenteditable 丢换行：输入其实已生效，
              // 不能再走 setter 重写一遍（会重复触发 input/change/搜索/自动保存）。
              const finalRead = await performTypeReadback(registry, params.target, run);
              const got = finalRead.ok ? String(finalRead.value ?? "") : "";
              const norm = (value: string) => value.replace(/\s+/g, " ").trim();
              if (got && (norm(got) === norm(expected) || norm(expected).startsWith(norm(got)))) {
                result = { ok: true, label: point.label ?? params.target };
                formatNote = "（页面按自身规则格式化/截断，未重复输入）";
              }
            }
          }
        }
        let degraded = false;
        if (!result) {
          // 原生 setter + InputEvent + 回读比对（React 受控组件不再「返回成功但页面没变」）
          result = await performType(registry, params.target, text, run);
          degraded = true;
        }
        env.fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 输入失败：${params.target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const degradedNote = degraded ? "（真实按键不可用/未生效，已降级为原生 setter）" : "";
        return { ok: true, content: statusLine(`已输入 ${result.label ?? params.target}`, settled) + formatNote + degradedNote };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_press_key",
    description:
      "发送按键：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown 或单个可见字符；可选 target（#eN 或 CSS）先聚焦该元素，缺省发到当前焦点/body。Enter 的表单提交用 requestSubmit 兜底，结果里说明实际触发的路径",
    permissions: { browser: true },
    schema: z.object({ key: z.string().min(1).max(20), target: z.string().min(1).max(500).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { key?: string; target?: string };
        const key = params.key ?? "";
        if (!isSupportedKey(key)) {
          return {
            ok: false,
            content: `[INVALID_KEY] 不支持的按键：${JSON.stringify(key)}。可用：${NAMED_KEYS.join("/")}，或单个可见字符（如 a、1、/）`,
          };
        }
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        if (params.target) {
          const binding = bindRefToTab(env.bindings, ctx.sessionId, tabId, params.target);
          if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        }
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = env.bindings.registry(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 有目标时先把光标停到目标上；键盘提示与全局提示同一套胶囊。
        if (params.target) {
          const point = await performTargetPoint(registry, params.target, run);
          if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
            env.pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
            const focus = await performFocus(registry, params.target, run);
            if (!focus.ok) return { ok: false, content: focus.message ?? "[FOCUS_MISMATCH] 目标无法聚焦" };
          }
        }
        // Enter / Space 会提交表单：按键参数里没有元素语义，必须先读出焦点元素的真实文案再判敏感
        // （ref/坐标只是「哪个元素」，不知道它是「确认支付」还是「下一页」）。
        // 只对这两个提交键探测：逐字输入走 browser_type，不为每个字符付一次脚本开销。
        if (key === "Enter" || key === " ") {
          const probe = (await run(buildFocusProbeScript()).catch(() => null)) as unknown;
          const descriptor = describeFocusProbe(probe);
          if (descriptor) {
            const verdict = classifySensitiveStep({
              toolName: "browser_press_key",
              params: { key, label: descriptor },
            });
            if (verdict.sensitive) {
              let allowed = false;
              if (env.hooks?.confirmSensitive) {
                try {
                  allowed = await env.hooks.confirmSensitive({
                    sessionId: ctx.sessionId,
                    tool: "browser_press_key",
                    label: descriptor,
                    reason: verdict.reason ?? "敏感步骤需要确认",
                    ...(before?.url ? { url: before.url } : {}),
                  });
                } catch {
                  allowed = false;
                }
              }
              if (!allowed) {
                return {
                  ok: false,
                  content: `[SENSITIVE_DENIED] 已拦截敏感按键 ${key}：焦点在「${descriptor}」上（${verdict.reason ?? "敏感步骤"}）。未发送按键；如确需执行，请在界面上确认`,
                };
              }
            }
          }
        }
        if (typeof host.isSessionVisible === "function" && host.isSessionVisible(ctx.sessionId)) {
          env.hooks?.pointer?.chip(`⌨ ${key === " " ? "Space" : key}`);
        }
        // 真实键盘事件优先：表单默认行为（提交/跳转/关弹窗）只有可信事件才会发生。
        const real = typeof host.agentKey === "function" ? await host.agentKey(ctx.sessionId, tabId ?? undefined, key) : false;
        const result = real
          ? { ok: true, label: params.target ?? "当前焦点", detail: "真实键盘事件" }
          : await performPressKey(registry, params.target ?? null, key, run);
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 按键失败：${key}` };
        env.fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已按键 ${key} → ${result.label ?? "当前焦点"}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_select",
    description:
      "在下拉框（<select>）里选择选项：target 必填（#eN 或 CSS），values 依次按 option 的 value 匹配、退而按可见文本匹配；原生 setter 设值 + input/change，并回读 selectedOptions 校验",
    permissions: { browser: true },
    schema: z.object({
      target: z.string().min(1).max(500),
      values: z.array(z.string().min(1).max(200)).min(1).max(20),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { target?: string; values?: string[] };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        if (!Array.isArray(params.values) || params.values.length === 0) {
          return { ok: false, content: "[错误] 缺少 values（要选中的 option 值或可见文本组成的数组）" };
        }
        const target = params.target;
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(env.bindings, ctx.sessionId, tabId, target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = env.bindings.registry(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 下拉框同样先让光标停到目标上（视觉一致；选中动作仍走原生 setter + 回读）。
        const point = await performTargetPoint(registry, target, run);
        if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
          env.pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
        }
        const result = await performSelect(registry, target, params.values, run);
        env.fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 选择失败：${target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已选择 ${result.label ?? target}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_drag",
    description:
      "拖拽元素：从 from 拖到 to（#eN / CSS / text=），真实鼠标按下 → 分帧移动 → 抬起；用于滑块、拖拽排序、画布/编辑器等场景",
    permissions: { browser: true },
    schema: z.object({ from: z.string().min(1).max(500), to: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { from?: string; to?: string };
        if (!params?.from || !params?.to) return { ok: false, content: "[错误] 缺少 from / to" };
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const fromBinding = bindRefToTab(env.bindings, ctx.sessionId, tabId, params.from);
        if (!fromBinding.ok) return { ok: false, content: fromBinding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const toBinding = bindRefToTab(env.bindings, ctx.sessionId, tabId, params.to);
        if (!toBinding.ok) return { ok: false, content: toBinding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = env.bindings.registry(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        const fromPoint = await performTargetPoint(registry, params.from, run);
        if (!fromPoint.ok || typeof fromPoint.x !== "number" || typeof fromPoint.y !== "number") {
          return { ok: false, content: fromPoint.message ?? `[错误] 拖拽起点定位失败：${params.from}` };
        }
        // 终点不再 scrollIntoView：拖拽过程中页面不能被滚动，否则按下位置与目标错位。
        const toPoint = await performTargetPoint(registry, params.to, run, { scrollIntoView: false });
        if (!toPoint.ok || typeof toPoint.x !== "number" || typeof toPoint.y !== "number") {
          return { ok: false, content: toPoint.message ?? `[错误] 拖拽终点定位失败：${params.to}` };
        }
        const shown = env.pointPointer(host, ctx.sessionId, tabId, { x: fromPoint.x, y: fromPoint.y, width: fromPoint.width, height: fromPoint.height });
        if (shown) {
          shown.pointer.chip("拖拽");
          await new Promise((resolve) => setTimeout(resolve, 240));
        }
        const real = typeof host.agentDrag === "function"
          ? await host.agentDrag(ctx.sessionId, tabId ?? undefined, { x: fromPoint.x, y: fromPoint.y }, { x: toPoint.x, y: toPoint.y })
          : false;
        if (!real) return { ok: false, content: "[错误] 当前视图不支持真实拖拽（sendInputEvent 不可用）" };
        env.pointPointer(host, ctx.sessionId, tabId, { x: toPoint.x, y: toPoint.y });
        env.fadePointerHighlight();
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已拖拽 ${fromPoint.label ?? params.from} → ${toPoint.label ?? params.to}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_hover",
    description:
      "把鼠标悬停到元素上（#eN 或 CSS）：滚进视野并派发 pointerover/pointerenter/mouseover/mouseenter/mousemove，用于展开菜单/悬浮提示",
    permissions: { browser: true },
    schema: z.object({ target: z.string().min(1).max(500) }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { target?: string };
        if (!params?.target) return { ok: false, content: "[错误] 缺少 target" };
        const target = params.target;
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const binding = bindRefToTab(env.bindings, ctx.sessionId, tabId, target);
        if (!binding.ok) return { ok: false, content: binding.message ?? "[STALE_REF] 引用已过期，请重新 browser_snapshot" };
        const before = readTab(host, ctx.sessionId, tabId);
        const registry = env.bindings.registry(ctx.sessionId, tabId);
        const run = (script: string) => host.executeScript(script, ctx.sessionId, tabId ?? undefined);
        // 悬停也要看得见：光标移到目标，再派发悬停事件（真实输入不改变 hover 语义）。
        const point = await performTargetPoint(registry, target, run);
        if (point.ok && typeof point.x === "number" && typeof point.y === "number") {
          const shown = env.pointPointer(host, ctx.sessionId, tabId, { x: point.x, y: point.y, width: point.width, height: point.height });
          if (shown) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // 真实鼠标移动优先：CSS :hover、pointerover、mouseover 都由可信鼠标事件驱动。
        const realHover =
          point.ok && typeof point.x === "number" && typeof point.y === "number" && typeof host.agentHover === "function"
            ? await host.agentHover(ctx.sessionId, tabId ?? undefined, { x: point.x, y: point.y })
            : false;
        const result = realHover
          ? { ok: true, label: point.label ?? target }
          : await performHover(registry, target, run);
        env.fadePointerHighlight();
        if (!result.ok) return { ok: false, content: result.message ?? `[错误] 悬停失败：${target}` };
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        const detail = result.detail ? `（${result.detail}）` : "";
        return { ok: true, content: statusLine(`已悬停 ${result.label ?? target}${detail}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  env.register({
    name: "browser_scroll",
    description:
      "滚动当前页面：down / up 走真实鼠标滚轮（虚拟光标移到页面中间后按 notch 滚动），top / bottom 直达；长页面分页阅读",
    permissions: { browser: true },
    schema: z.object({ direction: z.enum(["down", "up", "top", "bottom"]), amount: z.number().int().min(100).max(5000).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      try {
        const params = (ctx.params ?? {}) as { direction?: "down" | "up" | "top" | "bottom"; amount?: number };
        const direction = params.direction ?? "down";
        const amount = params.amount ?? 800;
        const host = env.needHost();
        const tabId = activeTabOf(host, ctx.sessionId);
        const before = readTab(host, ctx.sessionId, tabId);
        // down/up：真实滚轮（可信事件，滚动监听/吸顶/懒加载都会响应）；光标先滑到页面中间。
        let scrolled = false;
        if ((direction === "down" || direction === "up") && typeof host.agentWheel === "function") {
          const center = await host.getViewportCenter(ctx.sessionId, tabId ?? undefined);
          if (center) {
            const shown = env.pointPointer(host, ctx.sessionId, tabId, { x: center.x, y: center.y });
            if (shown) {
              shown.pointer.chip(direction === "down" ? "滚动 ↓" : "滚动 ↑");
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          scrolled = await host.agentWheel(ctx.sessionId, tabId ?? undefined, direction === "down" ? amount : -amount);
        }
        if (!scrolled) {
          const script =
            direction === "top"
              ? "window.scrollTo({ top: 0 }); 'ok'"
              : direction === "bottom"
                ? "window.scrollTo({ top: document.body.scrollHeight }); 'ok'"
                : `window.scrollBy({ top: ${direction === "up" ? -amount : amount} }); 'ok'`;
          await host.executeScript(script, ctx.sessionId);
        }
        const settled = await settleTab(host, ctx.sessionId, tabId, before);
        return { ok: true, content: statusLine(`已滚动：${direction}`, settled) };
      } catch (err) {
        return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
