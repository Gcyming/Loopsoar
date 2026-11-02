/**
 * 终端面板（应用内终端）：可拖拽的持久终端。
 *
 * 两种布局（由 `fullWidth` 决定）：
 *   · 默认（false）= 右侧 Agent 面板底部抽屉（旧行为完全不变）；
 *   · fullWidth = 从整个程序底部拉起的全宽面板（VS Code 风格）：根容器 100% 宽、顶部拖拽手柄横跨全行、
 *     工具栏/标签栏/输出/输入区横向铺满；类名 `.terminal-panel.is-fullwidth`，圆角/无硬边框等主题细节由 CSS 补充。
 *
 * 定位：在 Agent 工具之外，给人一个「看得见、可交互」的持久终端——
 * 多环境配置档（cmd / PowerShell / Git Bash / Python / Node / C++）、按会话隔离标签、
 * 流式输出、命令直执行与原始输入两种交互模式。
 *
 * 数据全部经 window.loopsoarAPI（terminal 域 + terminal:* 事件）；组件不碰 Node。
 * 不引第三方终端渲染库（xterm 等）：输出用 <pre> + ANSI 剥离（terminalAnsi.ts），
 * 交互是「命令行 / 原始 stdin」两种模式，零依赖且够日常调试用。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type {
  TerminalProfileInfo,
  TerminalSessionInfo,
  TerminalSessionState,
} from "./types.js";
import { decideFollow } from "./scrollFollow.js";
import { limitLines, normalizeTerminalText, stripAnsi, TERMINAL_MAX_LINES } from "./terminalAnsi.js";
import { useT } from "./i18n.js";

export interface TerminalPanelProps {
  /** 当前会话 ID：终端按会话隔离（切换会话时自动刷新标签）。 */
  sessionId?: string;
  /** 面板是否展开；关闭后组件保持挂载 —— 本地缓冲不丢、后台输出继续接收。 */
  open: boolean;
  onClose: () => void;
  /** 抽屉高度（px）；拖动/键盘调整时回调，持久化由 App 负责。 */
  height: number;
  onHeightChange: (height: number) => void;
  /**
   * 全宽底部面板模式（VS Code 风格，从整个程序底部拉起）：
   *   · 根容器宽度 100%，顶部拖拽手柄横跨整行；
   *   · 工具栏/标签栏/输出/输入区横向铺满，不再为窄侧栏换行；
   *   · 视觉类名 `.terminal-panel.is-fullwidth`（顶部圆角/无硬边框等细节由主题 CSS 补充）。
   * 默认 false = 旧的侧栏抽屉布局（行为完全不变）。
   */
  fullWidth?: boolean;
  /**
   * 高度拖拽开始（鼠标按下 / 键盘调整开始时）回调。
   * 为什么需要：全宽面板贴底时，拖动过程中鼠标会进入原生网页视图区域，事件被 WebContentsView 吞掉；
   * App 在这里临时隐藏原生视图（setOverlay({ open: true })），松手后再恢复。
   */
  onResizeStart?: () => void;
  /** 高度拖拽结束（鼠标松开 / 键盘调整完成时）回调；与 onResizeStart 成对调用。 */
  onResizeEnd?: () => void;
}

/** 原始输出缓冲上限（字符）：长跑进程只保留最近一段，避免内存无界。 */
const RAW_BUFFER_MAX_CHARS = 600_000;
/** 输出重排节流：主进程已按 30ms 批处理，这里再合并一次渲染，避免高频 setState。 */
const FLUSH_INTERVAL_MS = 48;
/** 高度键盘调整步长（px）。 */
const HEIGHT_KEY_STEP = 16;
/** 提示自动消失时间（与 App 的 toast 节奏一致）。 */
const NOTICE_TTL_MS = 4500;

/** 高度夹紧到契约范围（App 从 localStorage 恢复的旧值可能越界）。 */
export function clampTerminalHeight(value: number): number {
  if (!Number.isFinite(value)) return LAYOUT.TERMINAL_PANEL_HEIGHT;
  return Math.min(
    LAYOUT.TERMINAL_PANEL_MAX_HEIGHT,
    Math.max(LAYOUT.TERMINAL_PANEL_MIN_HEIGHT, Math.round(value)),
  );
}

/** 兼容读取列表结果：契约是裸数组；若宿主改成包一层（{profiles}/{terminals}）也不白屏。 */
function readList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const wrapped = (value as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return wrapped as T[];
  }
  return [];
}

/** 裁掉超长原始缓冲：优先从换行处切，避免开头留半个 ANSI 序列。 */
function trimRawBuffer(raw: string): string {
  if (raw.length <= RAW_BUFFER_MAX_CHARS) return raw;
  const from = raw.length - RAW_BUFFER_MAX_CHARS;
  const cut = raw.indexOf("\n", from);
  if (cut >= 0 && cut + 1 < raw.length) return raw.slice(cut + 1);
  return raw.slice(from);
}

/** 配置档标签兜底（terminal.label 缺失时用配置档显示名）。 */
function profileLabel(profiles: readonly TerminalProfileInfo[], key: string): string {
  return profiles.find((profile) => profile.key === key)?.label ?? key;
}

/* ---------------------------------- 组件 ---------------------------------- */

export default function TerminalPanel({
  sessionId,
  open,
  onClose,
  height,
  onHeightChange,
  fullWidth = false,
  onResizeStart,
  onResizeEnd,
}: TerminalPanelProps): React.JSX.Element | null {
  const api = useLoopsoarApi();
  const tr = useT();
  /** 终端状态文案（随语言切换即时更新）。 */
  const stateLabelOf = (state: TerminalSessionState): string => tr(`terminal.state.${state}`);
  const [profiles, setProfiles] = React.useState<TerminalProfileInfo[]>([]);
  const [terminals, setTerminals] = React.useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  /** 每个终端「已处理」的显示文本（stripAnsi + 规范化 + 限行后的结果）。 */
  const [texts, setTexts] = React.useState<Record<string, string>>({});
  const [profilesLoading, setProfilesLoading] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [rawMode, setRawMode] = React.useState(false);
  const [follow, setFollow] = React.useState(true);
  const [lastProfileKey, setLastProfileKey] = React.useState("");

  const outputRef = React.useRef<HTMLPreElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  /** 原始输出（含 ANSI / CR）：重排显示与回放都以它为准。 */
  const rawBuffersRef = React.useRef(new Map<string, string>());
  /** 待重排的终端 id（节流合并）。 */
  const dirtyRef = React.useRef(new Set<string>());
  const flushTimerRef = React.useRef<number | null>(null);
  const noticeTimerRef = React.useRef<number | null>(null);
  const followRef = React.useRef(true);
  const terminalsRef = React.useRef<TerminalSessionInfo[]>([]);
  const activeIdRef = React.useRef<string | null>(null);
  /** 正在进行的拖拽收尾函数（mouseup 未到达时由卸载清理兜底调用，保证 onResizeEnd 不丢）。 */
  const dragEndRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);
  React.useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const showNotice = React.useCallback((text: string): void => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), NOTICE_TTL_MS);
  }, []);

  /* ------------------------------ 输出缓冲管线 ------------------------------ */

  const flushDirty = React.useCallback((): void => {
    flushTimerRef.current = null;
    if (dirtyRef.current.size === 0) return;
    const dirty = [...dirtyRef.current];
    dirtyRef.current.clear();
    setTexts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const terminalId of dirty) {
        const raw = rawBuffersRef.current.get(terminalId) ?? "";
        const text = limitLines(normalizeTerminalText(stripAnsi(raw)), TERMINAL_MAX_LINES);
        if (next[terminalId] !== text) {
          next[terminalId] = text;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const scheduleFlush = React.useCallback((): void => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(flushDirty, FLUSH_INTERVAL_MS);
  }, [flushDirty]);

  /** 追加一段原始输出（主进程 terminal:data，或本地回显/退出提示），节流重排。 */
  const appendRaw = React.useCallback(
    (terminalId: string, chunk: string): void => {
      if (!terminalId || !chunk) return;
      const merged = trimRawBuffer((rawBuffersRef.current.get(terminalId) ?? "") + chunk);
      rawBuffersRef.current.set(terminalId, merged);
      dirtyRef.current.add(terminalId);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  /* -------------------------------- 事件订阅 -------------------------------- */

  React.useEffect(() => {
    if (!api) return;
    const offs: Array<() => void> = [];
    /** 旧 shell 未登记事件时 preload 会抛「不在契约白名单」：降级为不订阅，不影响面板打开。 */
    const safeOn = (subscribe: () => () => void): void => {
      try {
        offs.push(subscribe());
      } catch {
        // 静默降级：UI 可在旧 shell 上正常打开（只是没有实时输出）
      }
    };

    safeOn(() =>
      api.on("terminal:data", (payload) => {
        const p = payload as { terminalId?: unknown; data?: unknown; chunk?: unknown };
        if (typeof p?.terminalId !== "string") return;
        // 契约：stdout+stderr 合流在 data；chunk 是旧契约字段，兼容读取
        const chunk = typeof p.data === "string" ? p.data : typeof p.chunk === "string" ? p.chunk : "";
        if (!chunk) return;
        appendRaw(p.terminalId, chunk);
      }),
    );

    safeOn(() =>
      api.on("terminal:exit", (payload) => {
        const p = payload as { terminalId?: unknown; code?: unknown; signal?: unknown };
        if (typeof p?.terminalId !== "string") return;
        const terminalId = p.terminalId;
        setTerminals((prev) =>
          prev.map((item) => (item.terminalId === terminalId ? { ...item, state: "exited" as const } : item)),
        );
        const code = typeof p.code === "number" ? p.code : null;
        const signal = typeof p.signal === "string" && p.signal ? p.signal : "";
        const reason = signal
          ? tr("terminal.exit.bySignal", { signal })
          : code === null
            ? tr("terminal.exit.bySignalUnknown")
            : tr("terminal.exit.byCode", { code });
        // 本地留一行墓碑，避免用户以为终端「卡住了」
        appendRaw(terminalId, `\n${tr("terminal.exit.tombstone", { reason })}\n`);
      }),
    );

    safeOn(() =>
      api.on("terminal:state", (payload) => {
        const p = payload as { terminalId?: unknown; state?: unknown; cwd?: unknown; label?: unknown; error?: unknown };
        if (typeof p?.terminalId !== "string" || typeof p.state !== "string") return;
        const terminalId = p.terminalId;
        setTerminals((prev) =>
          prev.map((item) =>
            item.terminalId === terminalId
              ? {
                  ...item,
                  state: p.state as TerminalSessionState,
                  ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
                  ...(typeof p.label === "string" ? { label: p.label } : {}),
                }
              : item,
          ),
        );
        // error 态带中文原因：同时用面板提示条展示（输出区里也会有一行 [终端错误]）
        if (typeof p.error === "string" && p.error) showNotice(tr("terminal.errorNotice", { error: p.error }));
      }),
    );

    return () => {
      for (const off of offs) off();
    };
  }, [api, appendRaw, showNotice, tr]);

  // 卸载清理节流器，避免定时器泄漏（组件通常常驻，但测试/热更新会卸载）；
  // 若拖拽中卸载，补发 onResizeEnd，避免 App 的原生视图覆盖层被永久留在隐藏态。
  React.useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      dragEndRef.current?.();
    };
  }, []);

  /* ------------------------------ 打开 / 刷新 ------------------------------ */

  const refresh = React.useCallback(async (): Promise<void> => {
    // 旧 shell（未装配 terminal 域）直接降级为空态，不抛未处理异常
    if (!api?.terminal) return;
    setProfilesLoading(true);
    try {
      const [profilesResult, listResult] = await Promise.allSettled([api.terminal.profiles(), api.terminal.list()]);
      if (profilesResult.status === "fulfilled") {
        setProfiles(readList<TerminalProfileInfo>(profilesResult.value, "profiles"));
      } else {
        showNotice(tr("terminal.probeFailed"));
      }
      if (listResult.status === "fulfilled") {
        const all = readList<TerminalSessionInfo>(listResult.value, "terminals");
        const mine = sessionId ? all.filter((item) => item.sessionId === sessionId) : all;
        setTerminals(mine);
        setActiveId((current) => {
          if (current && mine.some((item) => item.terminalId === current)) return current;
          return mine[0]?.terminalId ?? null;
        });
      }
    } finally {
      setProfilesLoading(false);
    }
  }, [api, sessionId, showNotice, tr]);

  React.useEffect(() => {
    if (!open || !api) return;
    void refresh();
  }, [open, api, refresh]);

  /* --------------------------- 切换标签时回放历史 --------------------------- */

  const loadingHistoryRef = React.useRef(new Set<string>());

  /**
   * 用主进程环形缓冲补齐某个终端的输出（切换标签 / 新建终端时）。
   * 已有实时输出时跳过（banner/chunk 可能比 open 的 Promise 先到，重复回放会重影）。
   */
  const loadHistory = React.useCallback(
    async (terminalId: string): Promise<void> => {
      if (!api?.terminal || loadingHistoryRef.current.has(terminalId)) return;
      loadingHistoryRef.current.add(terminalId);
      try {
        const history = await api.terminal.history({ terminalId }).catch(() => null);
        const existing = rawBuffersRef.current.get(terminalId);
        if (existing && existing.length > 0) return; // 实时输出已到：不重复回放
        if (history && typeof history.data === "string") {
          const raw = trimRawBuffer(history.data);
          rawBuffersRef.current.set(terminalId, raw);
          // 回放不走节流：切标签应立即看到内容
          setTexts((prev) => ({
            ...prev,
            [terminalId]: limitLines(normalizeTerminalText(stripAnsi(raw)), TERMINAL_MAX_LINES),
          }));
          if (history.state) {
            setTerminals((prev) =>
              prev.map((item) =>
                item.terminalId === terminalId ? { ...item, state: history.state as TerminalSessionState } : item,
              ),
            );
          }
        } else {
          // 终端已不存在（或没有历史）：给个空缓冲区，避免每次切回都重拉
          if (!rawBuffersRef.current.has(terminalId)) rawBuffersRef.current.set(terminalId, "");
          setTexts((prev) => (prev[terminalId] !== undefined ? prev : { ...prev, [terminalId]: "" }));
        }
      } finally {
        loadingHistoryRef.current.delete(terminalId);
      }
    },
    [api],
  );

  React.useEffect(() => {
    if (!open || !api || !activeId) return;
    // 本地已有缓冲（实时输出 / 已回放 / 已清屏）就优先用本地，不再拉历史
    if (rawBuffersRef.current.has(activeId)) return;
    void loadHistory(activeId);
  }, [open, api, activeId, loadHistory]);

  /* -------------------------------- 派生数据 -------------------------------- */

  const activeTerminal = terminals.find((item) => item.terminalId === activeId) ?? null;
  const activeText = activeId ? (texts[activeId] ?? "") : "";
  /** 可输入：终端存在且未退出（starting 也放行，主进程会以 ok:false+error 拒绝未就绪操作）。 */
  const canType = activeTerminal !== null && activeTerminal.state !== "exited" && activeTerminal.state !== "error";

  const defaultProfile = React.useMemo<TerminalProfileInfo | null>(() => {
    const available = profiles.filter((profile) => profile.available);
    if (available.length === 0) return null;
    return available.find((profile) => profile.key === lastProfileKey) ?? available[0] ?? null;
  }, [profiles, lastProfileKey]);

  /* --------------------------------- 动作 --------------------------------- */

  const createTerminal = React.useCallback(
    async (profile: TerminalProfileInfo | null): Promise<void> => {
      if (!api) {
        showNotice(tr("terminal.notInShell"));
        return;
      }
      if (!profile) {
        showNotice(tr("terminal.noProfilesAvailable"));
        return;
      }
      if (!profile.available) {
        showNotice(profile.detail ?? tr("terminal.profileUnavailable", { label: profile.label }));
        return;
      }
      setPending(true);
      try {
        const info = await api.terminal.open({
          ...(sessionId ? { sessionId } : {}),
          profile: profile.key,
        });
        if (!info || typeof info.terminalId !== "string") throw new Error(tr("terminal.openMissingInfo"));
        setTerminals((prev) =>
          prev.some((item) => item.terminalId === info.terminalId) ? prev : [...prev, info],
        );
        setActiveId(info.terminalId);
        setLastProfileKey(profile.key);
        // 不要覆盖已有缓冲：banner/chunk 可能比 open 的 Promise 先到
        if (!rawBuffersRef.current.has(info.terminalId)) {
          rawBuffersRef.current.set(info.terminalId, "");
          setTexts((prev) => (prev[info.terminalId] !== undefined ? prev : { ...prev, [info.terminalId]: "" }));
          // 兜底：打开瞬间的 banner 可能赶在订阅回调之前，用 history 补一次（有实时输出则跳过）
          void loadHistory(info.terminalId);
        }
        followRef.current = true;
        setFollow(true);
        inputRef.current?.focus();
      } catch (err) {
        // 契约：open 失败走 Promise reject（超限 / 不可用 / cwd 越界 / 启动失败）
        showNotice(tr("terminal.openFailed", { error: err instanceof Error ? err.message : String(err) }));
      } finally {
        setPending(false);
      }
    },
    [api, sessionId, showNotice, loadHistory, tr],
  );

  const selectTerminal = React.useCallback(
    (terminalId: string): void => {
      if (terminalId === activeId) return;
      setActiveId(terminalId);
      followRef.current = true;
      setFollow(true);
    },
    [activeId],
  );

  /** 本地移除终端（主进程 close 后同步 UI）并从剩余标签里选下一个。 */
  const removeLocalTerminal = React.useCallback((terminalId: string): void => {
    rawBuffersRef.current.delete(terminalId);
    dirtyRef.current.delete(terminalId);
    setTexts((prev) => {
      if (!(terminalId in prev)) return prev;
      const next = { ...prev };
      delete next[terminalId];
      return next;
    });
    const remaining = terminalsRef.current.filter((item) => item.terminalId !== terminalId);
    setTerminals(remaining);
    if (activeIdRef.current === terminalId) {
      setActiveId(remaining[0]?.terminalId ?? null);
    }
  }, []);

  const interruptActive = React.useCallback(async (): Promise<void> => {
    if (!api || !activeId) return;
    const hit = await api.terminal.interrupt({ terminalId: activeId }).catch(() => false);
    // Windows 下管道 stdin 发不出控制台 ^C，主进程会结束整棵进程树 → 终端随后进入 exited；
    // 这里只提示语义，状态由 terminal:exit/state 事件驱动（标签变「已退出」、输入自动禁用）。
    showNotice(
      hit
        ? tr("terminal.interruptSent")
        : tr("terminal.interruptMiss"),
    );
  }, [api, activeId, showNotice, tr]);

  const closeActive = React.useCallback(async (): Promise<void> => {
    if (!api || !activeId) return;
    setPending(true);
    try {
      await api.terminal.close({ terminalId: activeId }).catch(() => false);
      removeLocalTerminal(activeId);
    } finally {
      setPending(false);
    }
  }, [api, activeId, removeLocalTerminal]);

  const clearOutput = React.useCallback((): void => {
    if (!activeId) return;
    rawBuffersRef.current.set(activeId, "");
    dirtyRef.current.delete(activeId);
    setTexts((prev) => ({ ...prev, [activeId]: "" }));
    showNotice(tr("terminal.cleared"));
  }, [activeId, showNotice, tr]);

  /** 提交命令 / 原始输入；appendNewline 只对原始输入模式生效（严格由用户控制）。 */
  const submit = React.useCallback(
    async (appendNewline: boolean): Promise<void> => {
      if (!api || !activeTerminal) return;
      if (!canType) {
        showNotice(tr("terminal.exitedCannotType"));
        return;
      }
      const terminalId = activeTerminal.terminalId;
      const raw = rawBuffersRef.current.get(terminalId) ?? "";
      const atLineStart = raw.length === 0 || raw.endsWith("\n");
      if (rawMode) {
        // 原始模式：Enter 原样发送（空输入=单独回车）；Ctrl/Shift+Enter 追加 \n
        const data = command.length > 0 ? (appendNewline ? `${command}\n` : command) : "\n";
        setCommand("");
        appendRaw(terminalId, data); // 本地回显（stdin 非 tty 时进程不会自动回显）
        const result = await api.terminal.input({ terminalId, data }).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        if (!result?.ok) showNotice(result?.error ?? tr("terminal.inputFailed"));
        return;
      }
      const text = command.trim();
      if (!text) return;
      setCommand("");
      appendRaw(terminalId, `${atLineStart ? "" : "\n"}$ ${text}\n`);
      const result = await api.terminal.run({ terminalId, command: text }).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!result?.ok) showNotice(result?.error ?? tr("terminal.runFailed"));
    },
    [api, activeTerminal, canType, command, rawMode, appendRaw, showNotice, tr],
  );

  /* -------------------------------- 高度拖拽 -------------------------------- */

  const onResizerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      let next: number | null = null;
      if (event.key === "ArrowUp") next = clampTerminalHeight(height + HEIGHT_KEY_STEP);
      else if (event.key === "ArrowDown") next = clampTerminalHeight(height - HEIGHT_KEY_STEP);
      else if (event.key === "Home") next = LAYOUT.TERMINAL_PANEL_MIN_HEIGHT;
      else if (event.key === "End") next = LAYOUT.TERMINAL_PANEL_MAX_HEIGHT;
      if (next === null) return;
      event.preventDefault();
      // 键盘调整是原子操作：开始 → 变更 → 结束在同一事件内成对触发，App 可据此临时隐藏原生视图。
      onResizeStart?.();
      try {
        onHeightChange(next);
      } finally {
        onResizeEnd?.();
      }
    },
    [height, onHeightChange, onResizeEnd, onResizeStart],
  );

  const startHeightDrag = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      let ended = false;
      const onMove = (moveEvent: MouseEvent): void => {
        // 面板贴在底部：鼠标向上拖 → 高度增大
        onHeightChange(clampTerminalHeight(startHeight + (startY - moveEvent.clientY)));
      };
      const onUp = (): void => {
        if (ended) return;
        ended = true;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        dragEndRef.current = null;
        // 必须在原生视图恢复前同步通知 App（恢复后再次拖动仍能命中手柄）
        onResizeEnd?.();
      };
      dragEndRef.current = onUp;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      // 窗口失焦（拖到窗口外松手 / Alt+Tab）也收尾，避免覆盖层卡在隐藏态
      window.addEventListener("blur", onUp);
      // 先通知 App 临时隐藏原生网页视图（否则拖动时鼠标进入 WebContentsView 会丢事件）
      onResizeStart?.();
    },
    [height, onHeightChange, onResizeEnd, onResizeStart],
  );

  /* ------------------------------ 输出跟随最新 ------------------------------ */

  React.useLayoutEffect(() => {
    if (!open || !follow) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, follow, activeId, activeText]);

  const handleOutputScroll = React.useCallback((): void => {
    const el = outputRef.current;
    if (!el) return;
    const next = decideFollow({
      top: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      following: followRef.current,
    });
    followRef.current = next;
    setFollow(next);
  }, []);

  const jumpToLatest = React.useCallback((): void => {
    followRef.current = true;
    setFollow(true);
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* -------------------------------- 键盘输入 -------------------------------- */

  const onCommandKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      // 原始模式下 Ctrl/Shift+Enter 追加换行，其余 Enter 原样发送
      void submit(rawMode && (event.ctrlKey || event.metaKey || event.shiftKey));
    },
    [rawMode, submit],
  );

  if (!open) return null;

  const clampedHeight = clampTerminalHeight(height);
  const stateLabel = activeTerminal ? stateLabelOf(activeTerminal.state) : "";

  return (
    <section
      className={`terminal-panel${fullWidth ? " is-fullwidth" : ""}`}
      style={{ ...styles.panel, ...(fullWidth ? styles.panelFullWidth : null), height: clampedHeight }}
      aria-label={tr("terminal.panelLabel")}
    >
      {/* 高度拖拽条：鼠标拖动 / 上下方向键 / Home·End；行内角色做无障碍语义。
          fullWidth 下沿面板上边缘横跨整行（拖拽开始/结束通知 App 隐藏原生视图）。 */}
      <div
        className="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={tr("terminal.resizeLabel")}
        aria-valuemin={LAYOUT.TERMINAL_PANEL_MIN_HEIGHT}
        aria-valuemax={LAYOUT.TERMINAL_PANEL_MAX_HEIGHT}
        aria-valuenow={clampedHeight}
        aria-valuetext={tr("terminal.resizeValueText", { height: clampedHeight })}
        tabIndex={0}
        title={tr("terminal.resizeTitle")}
        style={fullWidth ? styles.resizerFullWidth : undefined}
        onMouseDown={startHeightDrag}
        onKeyDown={onResizerKeyDown}
      />
      <div className="terminal-toolbar" style={fullWidth ? styles.toolbarFullWidth : undefined}>
        <div
          className="terminal-profiles"
          role="group"
          aria-label={tr("terminal.profilesGroup")}
          style={fullWidth ? styles.profilesFullWidth : undefined}
        >
          {profilesLoading && profiles.length === 0 ? <span className="terminal-hint">{tr("terminal.probing")}</span> : null}
          {profiles.map((profile) => (
            <button
              key={profile.key}
              type="button"
              className={`terminal-profile${profile.available ? "" : " is-disabled"}${
                activeTerminal?.profile === profile.key ? " is-active" : ""
              }`}
              disabled={!profile.available || pending}
              title={
                profile.available
                  ? tr("terminal.profileTip", {
                      description: `${profile.description}${profile.version ? ` · ${profile.version}` : ""}`,
                    })
                  : tr("terminal.profileTipUnavailable", {
                      label: profile.label,
                      detail: profile.detail ?? tr("terminal.notInstalled"),
                    })
              }
              aria-label={
                profile.available
                  ? tr("terminal.profileNewAria", { label: profile.label })
                  : tr("terminal.profileNewAriaDisabled", { label: profile.label })
              }
              onClick={() => void createTerminal(profile)}
            >
              {profile.label}
            </button>
          ))}
          {!profilesLoading && profiles.length === 0 ? (
            <span className="terminal-hint">{tr("terminal.noProfiles")}</span>
          ) : null}
        </div>
        {activeTerminal ? (
          <span
            className="terminal-state"
            data-state={activeTerminal.state}
            title={tr("terminal.stateTitle", { state: stateLabel })}
          >
            {stateLabel}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-btn terminal-close-btn"
          title={tr("terminal.closePanel")}
          aria-label={tr("terminal.closePanel")}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {notice ? (
        <div className="terminal-notice" role="status">
          {notice}
        </div>
      ) : null}
      {terminals.length > 0 ? (
        <div className="terminal-tabbar" style={fullWidth ? styles.tabbarFullWidth : undefined}>
          <div className="terminal-tabs" role="tablist" aria-label={tr("terminal.tabsLabel")}>
            {terminals.map((item) => (
              <button
                key={item.terminalId}
                type="button"
                role="tab"
                aria-selected={item.terminalId === activeId}
                className={`terminal-tab${item.terminalId === activeId ? " is-active" : ""}`}
                title={tr("terminal.tabTitle", {
                  label: item.label || profileLabel(profiles, item.profile),
                  cwd: item.cwd,
                  state: stateLabelOf(item.state),
                })}
                onClick={() => selectTerminal(item.terminalId)}
              >
                <span className="terminal-tab-dot" data-state={item.state} aria-hidden="true" />
                <span className="terminal-tab-label">{item.label || profileLabel(profiles, item.profile)}</span>
              </button>
            ))}
            <button
              type="button"
              className="terminal-tab-add"
              title={
                defaultProfile
                  ? tr("terminal.newTerminalWith", { profile: defaultProfile.label })
                  : tr("terminal.newTerminal")
              }
              aria-label={tr("terminal.newTerminal")}
              disabled={pending || !defaultProfile}
              onClick={() => void createTerminal(defaultProfile)}
            >
              <Icon name="plus" size={11} />
            </button>
          </div>
          <span className="terminal-actions">
            <button
              type="button"
              className="terminal-action"
              title={tr("terminal.interruptTitle")}
              onClick={() => void interruptActive()}
              disabled={!canType}
            >
              {tr("terminal.interrupt")}
            </button>
            <button
              type="button"
              className="terminal-action"
              title={tr("terminal.clearTitle")}
              onClick={clearOutput}
              disabled={!activeTerminal}
            >
              {tr("terminal.clear")}
            </button>
            <button
              type="button"
              className="terminal-action"
              title={tr("terminal.closeTerminalTitle")}
              onClick={() => void closeActive()}
              disabled={!activeTerminal || pending}
            >
              {tr("terminal.closeTerminal")}
            </button>
          </span>
        </div>
      ) : null}
      {terminals.length === 0 ? (
        <div className="terminal-empty">
          <Icon name="terminal" size={22} style={styles.emptyIcon} />
          <div className="terminal-empty-title">{tr("terminal.emptyTitle")}</div>
          <div className="terminal-empty-hint">
            {profilesLoading && profiles.length === 0
              ? tr("terminal.emptyHintLoading")
              : defaultProfile
                ? tr("terminal.emptyHintAvailable", { profile: defaultProfile.label })
                : tr("terminal.emptyHintNone")}
          </div>
          <button
            type="button"
            className="btn-ghost terminal-empty-btn"
            onClick={() => void createTerminal(defaultProfile)}
            disabled={!defaultProfile || pending}
          >
            {tr("terminal.newTerminal")}
          </button>
        </div>
      ) : (
        <div className="terminal-output-wrap" style={fullWidth ? styles.outputWrapFullWidth : undefined}>
          <pre
            ref={outputRef}
            className="terminal-output"
            onScroll={handleOutputScroll}
            tabIndex={0}
            aria-label={tr("terminal.outputLabel")}
          >
            {activeText}
          </pre>
          {!follow ? (
            <button type="button" className="terminal-jump" onClick={jumpToLatest}>
              {tr("terminal.jumpLatest")}
            </button>
          ) : null}
        </div>
      )}
      <div className="terminal-command" style={fullWidth ? styles.commandFullWidth : undefined}>
        <span className="terminal-prompt" aria-hidden="true">
          {rawMode ? "»" : "›"}
        </span>
        <input
          ref={inputRef}
          className="terminal-command-input"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onCommandKeyDown}
          placeholder={
            !activeTerminal
              ? tr("terminal.placeholderNoTerminal")
              : !canType
                ? tr("terminal.placeholderExited")
                : rawMode
                  ? tr("terminal.placeholderRaw")
                  : tr("terminal.placeholderRun")
          }
          aria-label={rawMode ? tr("terminal.ariaInputRaw") : tr("terminal.ariaInputRun")}
          disabled={!canType}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className={`terminal-raw-toggle${rawMode ? " is-on" : ""}`}
          aria-pressed={rawMode}
          title={tr("terminal.rawTitle")}
          onClick={() => {
            setRawMode((prev) => !prev);
            inputRef.current?.focus();
          }}
        >
          {tr("terminal.raw")}
        </button>
        <button
          type="button"
          className="terminal-send"
          title={rawMode ? tr("terminal.sendRaw") : tr("terminal.sendRun")}
          aria-label={rawMode ? tr("terminal.sendRaw") : tr("terminal.sendRun")}
          onClick={() => void submit(false)}
          disabled={!canType || pending}
        >
          <Icon name="send" size={12} style={styles.sendIcon} />
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------- 样式 ---------------------------------- */
/** 颜色取自 BRAND/既有输出区规范；布局与交互态在 index.html 的 .terminal-* 中。 */
const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: BRAND.inkPanel,
    borderTop: `1px solid ${BRAND.borderStrong}`,
  },
  /**
   * 全宽底部面板：宽度铺满、顶部圆角、无硬边框（用 BRAND.border 的内阴影画一条 1px 分隔线，
   * 保留「浮起面板」的层次感）；具体主题细节（如更强的阴影/动画）由 `.terminal-panel.is-fullwidth` 的 CSS 补充。
   */
  panelFullWidth: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    borderTop: "none",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    boxShadow: `inset 0 1px 0 ${BRAND.border}`,
  },
  /** 全宽时拖拽手柄横跨整行，稍微加高更易命中（视觉 grip 由 .terminal-resizer::after 绘制）。 */
  resizerFullWidth: { width: "100%", height: 8 },
  /** 工具栏横向撑满：左侧 6 个配置档 chips，右侧状态点 + 关闭按钮（由 flex 自然分布）。 */
  toolbarFullWidth: { width: "100%", boxSizing: "border-box", gap: 8, padding: "0 12px 6px" },
  /** 全宽下配置档保持单行（空间足够，不再像窄侧栏那样换行；窗口极窄时横向滚动）。 */
  profilesFullWidth: { flexWrap: "nowrap", overflowX: "auto", scrollbarWidth: "none" },
  /** 标签栏铺满：标签左对齐、中断/清屏/关闭终端固定在右侧。 */
  tabbarFullWidth: { width: "100%", boxSizing: "border-box", padding: "0 12px" },
  /** 输出区铺满。 */
  outputWrapFullWidth: { width: "100%" },
  /** 输入行铺满：提示符 + 输入框（flex:1）+ 原始模式/发送按钮。 */
  commandFullWidth: { width: "100%", boxSizing: "border-box", padding: "6px 12px" },
  emptyIcon: { color: BRAND.linenFaint },
  sendIcon: { color: BRAND.ink },
};
