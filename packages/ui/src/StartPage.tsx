/**
 * 浏览器区起始面 / 新标签页 / Vibecoding 会话页。
 *
 * 状态（互斥）：
 *   · loading / error：原生 WebContentsView 加载中/失败时由宿主隐藏，本组件接管显示加载页、分类错误页；
 *   · ntp（新建标签页）：品牌 + 搜索/Vibecoding 拨片 + 输入区；搜索模式按用户设置的引擎搜索，
 *     Vibecoding 模式输入 prompt + 模型选择，发送后切到会话页；
 *   · chat（Vibecoding 会话）：复用 MessageList 展示当前会话消息，底部输入框（发送栏从中间平滑下移）。
 *
 * 纯展示 + 局部交互；搜索/发送/模型选择/停止等动作全部由 App 注入（本组件不持有会话状态）。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { LAYOUT } from "loopsoar-contracts/layout";
import type { SearchEngine } from "loopsoar-contracts/omnibox";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { usePopover } from "./popover.js";
import MessageList from "./MessageList.js";
import type { ChatMessage } from "./chatStreamState.js";
import type { ModelGroup } from "./modelGroups.js";
import type { WorkspaceRecord } from "./types.js";
import { classifyLoadFailure, type BrowserLoadFailureInfo, type BrowserFailureKind } from "./browserFailure.js";

const FAILURE_VIEW: Record<BrowserFailureKind, { icon: string; titleKey: string; descKey: string }> = {
  offline: { icon: "offline", titleKey: "browser.error.offline.title", descKey: "browser.error.offline.desc" },
  dns: { icon: "globe", titleKey: "browser.error.dns.title", descKey: "browser.error.dns.desc" },
  refused: { icon: "link-off", titleKey: "browser.error.refused.title", descKey: "browser.error.refused.desc" },
  timeout: { icon: "clock", titleKey: "browser.error.timeout.title", descKey: "browser.error.timeout.desc" },
  ssl: { icon: "lock", titleKey: "browser.error.ssl.title", descKey: "browser.error.ssl.desc" },
  blocked: { icon: "shield-off", titleKey: "browser.error.blocked.title", descKey: "browser.error.blocked.desc" },
  generic: { icon: "warning", titleKey: "browser.error.generic.title", descKey: "browser.error.generic.desc" },
};

export interface StartPageProps {
  /** 当前活动标签的 URL；空串 = 新建标签页。 */
  currentUrl: string;
  /** 侧栏宽度动画期间隐藏 DOM（原生网页视图尚未对齐时，防止初始页内容从缝隙漏出）。 */
  hidden?: boolean;
  /** 主框架加载中。 */
  loading: boolean;
  /** 最近一次主框架加载失败；null = 无失败。 */
  failure: BrowserLoadFailureInfo | null;
  /** 重新加载失败/正在加载的页面。 */
  onRetry: () => void;
  /** 返回上一页（有后退历史时才传，用于错误页次要操作）。 */
  onBack?: () => void;
  /** 用户设置的默认搜索引擎（新标签页搜索框左侧图标）。 */
  searchEngine: SearchEngine;
  /** 提交搜索/网址：App 用偏好里的引擎解析并导航。 */
  onSubmitSearch: (input: string) => void;
  /** 点击快捷入口（历史记录）时在当前标签打开。 */
  onOpenUrl: (url: string) => void;
  /** 当前模型的可读标签（provider · model），用于 Vibecoding 输入区模型胶囊。 */
  modelLabel: string;
  /** 跨供应商模型清单（模型胶囊下拉；null = 加载中）。 */
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  /** 当前会话消息（Vibecoding 会话页复用 MessageList 渲染）。 */
  messages: ChatMessage[];
  chatMode: "build" | "plan";
  busy: boolean;
  contextUsed: number;
  contextCap: number;
  contextPct: number;
  thinkingOpen: Record<string, boolean>;
  onToggleThinking: (id: string) => void;
  onRollback: (id: string) => void;
  onRegenerate: (id: string) => void;
  /** Vibecoding 第一次发送：App 负责「必要时新建会话 + 发送」并切到会话态。 */
  onStartVibe: (text: string) => void;
  /** 会话页内继续发送。 */
  onSendMessage: (text: string) => void;
  onStop: () => void;
  /** 新建标签页令牌：变化时重置回「搜索」初始页（tabMode=search）。 */
  resetToken?: number;
  /** 新建会话令牌（不新建标签页）：只把主页面切回初始页，保留当前搜索/Vibecoding 模式。 */
  sessionResetToken?: number;
  /** Vibecoding 模式变化（侧栏据此把会话按钮平滑换成「会话列表」按钮）。 */
  onVibeModeChange?: (vibe: boolean) => void;
  /** 推理等级候选 / 当前值 / 文案 / 修改回调（模型声明支持时显示推理 chip）。 */
  effortOptions: string[];
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  effortLabel: (value: string) => string;
  /** 对话模式 build/plan。 */
  chatBuildMode: "build" | "plan";
  onToggleBuildMode: () => void;
  /** 工作区（加号菜单里选择；新建走 App 的 workspace.create 原生文件夹选择器）。 */
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /** 选择附件（App 注入原生文件选择器）；返回路径后由 StartPage 插入当前输入草稿。 */
  onPickAttachment: () => Promise<string | null>;
  /** 会话级「浏览器控制」开关：关闭（默认）时 browser_* 工具对模型不可见。 */
  browserControl: boolean;
  /** 切换「浏览器控制」（App 落库到会话；草稿态先记待落库标志）。 */
  onToggleBrowserControl: () => void;
  /** 工作区「更多」：打开详细工作区面板（App 的 WorkspacePanel）。 */
  onOpenWorkspacePanel?: () => void;
}

/** 从 URL 取可读主机名（错误页/加载页展示用）。 */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.pathname || url;
  } catch {
    return url;
  }
}

function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(152, Math.max(22, el.scrollHeight))}px`;
}

export default function StartPage(props: StartPageProps): React.JSX.Element {
  const tr = useT();
  const { currentUrl, loading, failure, onRetry, onBack, searchEngine } = props;
  const kind = failure ? classifyLoadFailure(failure) : null;
  const view = kind ? FAILURE_VIEW[kind] : null;

  /** ntp = 新建标签页；chat = Vibecoding 会话页（发送后平滑切换）。 */
  const [mode, setMode] = React.useState<"ntp" | "chat">("ntp");
  /** 新标签页拨片：搜索 / Vibecoding。 */
  const [tabMode, setTabMode] = React.useState<"search" | "vibe">("search");
  const [draft, setDraft] = React.useState("");

  // 页面被真正导航走（有 URL）后回到新标签页状态：下次回到空白页仍是起始页，而不是旧会话。
  React.useEffect(() => {
    if (currentUrl) {
      setMode("ntp");
      setTabMode("search");
      setDraft("");
    }
  }, [currentUrl]);

  // Vibecoding 状态上报：侧栏据此把「会话 chip」平滑换成「会话列表」按钮。
  // 必须用 useLayoutEffect：与侧栏「模式切换遮罩」同帧生效；用 useEffect 时 App 的 vibeModeActive
  // 会在首帧 paint 后才更新，侧栏宽度变化晚一帧，某些调度下会看到一帧旧内容 + 新布局。
  React.useLayoutEffect(() => {
    // 不复用 currentUrl 判断：NTP 可能在「地址栏仍有 URL、原生网页视图暂时隐藏」的状态下显示（用户截图场景），
    // 此时 tabMode=vibe 仍是用户看到的界面，侧栏必须同步切成会话列表；导航发生时下面的 effect 会把 tabMode 复位为 search。
    props.onVibeModeChange?.(mode === "chat" || tabMode === "vibe");
  }, [mode, tabMode, props.onVibeModeChange]);
  // Vibecoding 页面：主页面显示会话正文（右栏只剩会话列表）。
  // 切换拨片或从右栏列表选择已有会话时，只要该会话有消息，就把左页从「今天想聊点什么」切到会话页。
  // 用 useLayoutEffect：与拨片切换同帧，避免先闪一帧初始页（用户 m07865）。
  React.useLayoutEffect(() => {
    if (tabMode === "vibe" && props.messages.length > 0) setMode("chat");
  }, [tabMode, props.messages]);

  // 新标签页：回到「搜索」初始页（用户 m07920：新建标签页 = 新会话 = 搜索页）。
  React.useLayoutEffect(() => {
    if (props.resetToken === undefined) return;
    setMode("ntp");
    setTabMode("search");
    setDraft("");
  }, [props.resetToken]);

  // 新建会话（不新建标签页）：只回初始页，保留当前搜索/Vibecoding 模式（用户 m08041：点新建会话不应跳搜索）。
  React.useLayoutEffect(() => {
    if (props.sessionResetToken === undefined) return;
    setMode("ntp");
    setDraft("");
  }, [props.sessionResetToken]);

  /** 选择附件后插入草稿：与新标签页/会话页共用同一份 draft。 */
  const attachFile = (): void => {
    void props.onPickAttachment()
      .then((path) => {
        if (!path) return;
        const inserted = tr("composer.insertAttachment", { path });
        setDraft((prev) => (prev ? `${prev}\n${inserted}` : inserted));
      })
      .catch(() => undefined);
  };

  const submitSearch = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    props.onSubmitSearch(text);
  };

  const submitVibe = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMode("chat");
    props.onStartVibe(text);
  };

  return (
    <section style={{ ...styles.browserPane, ...(props.hidden ? { visibility: "hidden" as const } : {}) }}>
      {failure && view ? (
        <div style={styles.statePane} data-browser-state="error" data-browser-error={kind}>
          <div style={styles.errorIconWrap}>
            <Icon name={view.icon} size={46} style={styles.errorIcon} />
          </div>
          <div style={styles.errorTitle}>{tr(view.titleKey)}</div>
          <div style={styles.errorDesc}>{tr(view.descKey)}</div>
          <div style={styles.errorTarget} title={failure.url}>
            {failure.url || tr("browser.error.unknownTarget")}
          </div>
          <div style={styles.errorCode}>{tr("browser.error.code", { code: failure.code, description: failure.description || "ERR_FAILED" })}</div>
          <div style={styles.errorActions}>
            <button type="button" className="btn-ghost" style={styles.primaryBtn} onClick={onRetry}>
              <Icon name="reload" size={14} style={styles.btnIcon} />
              {tr("browser.error.retry")}
            </button>
            {onBack ? (
              <button type="button" className="btn-ghost" style={styles.secondaryBtn} onClick={onBack}>
                {tr("browser.error.back")}
              </button>
            ) : null}
          </div>
          <div style={styles.errorHint}>{tr("browser.error.hint")}</div>
        </div>
      ) : loading ? (
        <div style={styles.statePane} data-browser-state="loading">
          <div style={styles.loadingLogoWrap}>
            <img src="./logo.png" alt="Loopsoar" width={58} height={58} className="browser-loading-logo" />
          </div>
          <div style={styles.loadingTitle}>{tr("browser.loading.title")}</div>
          <div style={styles.loadingTarget} title={currentUrl}>{hostOf(currentUrl)}</div>
          <div className="browser-loading-bar" style={styles.loadingBar}>
            <span style={styles.loadingBarFill} />
          </div>
          <div style={styles.loadingHint}>{tr("browser.loading.hint")}</div>
        </div>
      ) : mode === "chat" ? (
        <VibeChatView
          {...props}
          onAttach={attachFile}
          draft={draft}
          onDraftChange={setDraft}
          onSend={(): void => {
            const text = draft.trim();
            if (!text || props.busy) return;
            setDraft("");
            props.onSendMessage(text);
          }}
        />
      ) : (
        <NewTabPage
          {...props}
          onAttach={attachFile}
          tabMode={tabMode}
          onTabModeChange={setTabMode}
          draft={draft}
          onDraftChange={setDraft}
          onSubmitSearch={submitSearch}
          onSubmitVibe={submitVibe}
          searchEngine={searchEngine}
        />
      )}
    </section>
  );
}

/* ───────────────────────────── 新建标签页 ───────────────────────────── */

interface NewTabPageProps extends StartPageProps {
  onAttach: () => void;
  tabMode: "search" | "vibe";
  onTabModeChange: (mode: "search" | "vibe") => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmitSearch: () => void;
  onSubmitVibe: () => void;
  searchEngine: SearchEngine;
}

function NewTabPage({
  tabMode,
  onTabModeChange,
  draft,
  onDraftChange,
  onSubmitSearch,
  onSubmitVibe,
  searchEngine,
  modelLabel,
  modelGroups,
  onChooseModel,
  onOpenUrl,
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  chatBuildMode,
  onToggleBuildMode,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onOpenWorkspacePanel,
  onAttach,
  browserControl,
  onToggleBrowserControl,
}: NewTabPageProps): React.JSX.Element {
  const tr = useT();
  const api = useLoopsoarApi();
  const [links, setLinks] = React.useState<{ url: string; title: string; favicon?: string }[]>([]);

  // 快捷入口：取全局历史最近 6 条（没有历史就不显示，保持页面干净）。
  React.useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.browser
      .history({})
      .then((r) => {
        if (!alive) return;
        const next = r.entries
          .slice(0, 6)
          .map((item) => ({ url: item.url, title: item.title || item.url, favicon: item.favicon }))
          .filter((item) => item.url);
        setLinks(next);
        // 旧历史没有 favicon：按页面 URL 回抓一次（主进程抓取并写回历史），抓到后原地刷新。
        void Promise.allSettled(
          next.map(async (link, index) => {
            if (link.favicon) return;
            const resolved = await api.browser.resolveFavicon({ url: link.url });
            if (!resolved?.favicon) return;
            setLinks((prev) => prev.map((item, i) => (i === index ? { ...item, favicon: resolved.favicon ?? undefined } : item)));
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (tabMode === "search") onSubmitSearch();
    else onSubmitVibe();
  };

  return (
    <div style={styles.ntp} data-browser-state="idle" data-ntp-mode={tabMode}>
      <div style={styles.ntpInner}>
        <div style={styles.brandRow}>
          <img src="./logo.png" alt="Loopsoar" width={44} height={44} />
          <span style={styles.brandName}>Loopsoar</span>
        </div>

        {/* 搜索 / Vibecoding 拨片：滑块 + 两个标签，切换时内容淡入 */}
        <div style={styles.modeToggle} role="tablist" aria-label={tr("browser.ntp.modeAria")}>
          <span
            style={{
              ...styles.modeThumb,
              transform: tabMode === "search" ? "translateX(0%)" : "translateX(100%)",
            }}
          />
          <button
            type="button"
            role="tab"
            aria-selected={tabMode === "search"}
            style={{ ...styles.modeBtn, ...(tabMode === "search" ? styles.modeBtnActive : null) }}
            onClick={() => onTabModeChange("search")}
            data-testid="ntp-mode-search"
          >
            <Icon name="search" size={13} style={styles.modeBtnIcon} />
            {tr("browser.ntp.modeSearch")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tabMode === "vibe"}
            style={{ ...styles.modeBtn, ...(tabMode === "vibe" ? styles.modeBtnActive : null) }}
            onClick={() => onTabModeChange("vibe")}
            data-testid="ntp-mode-vibe"
          >
            <Icon name="sparkle" size={13} style={styles.modeBtnIcon} />
            {tr("browser.ntp.modeVibe")}
          </button>
        </div>

        <div key={tabMode} className="vibe-page-in" style={styles.modeBody}>
          {tabMode === "search" ? (
            <>
              <h1 style={styles.ntpTitle}>{tr("browser.ntp.searchTitle")}</h1>
              <div style={styles.searchBox}>
                <img
                  src={`./icons/engine-${searchEngine}.svg`}
                  width={20}
                  height={20}
                  alt=""
                  draggable={false}
                  style={styles.searchEngineIcon}
                />
                <input
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={tr("browser.ntp.searchPlaceholder")}
                  aria-label={tr("browser.ntp.searchPlaceholder")}
                  style={styles.searchInput}
                  data-testid="ntp-search-input"
                  autoFocus
                />
                <button
                  type="button"
                  className="icon-btn"
                  style={styles.searchSubmit}
                  title={tr("browser.ntp.searchSubmit")}
                  aria-label={tr("browser.ntp.searchSubmit")}
                  onClick={onSubmitSearch}
                >
                  <Icon name="search" size={16} />
                </button>
              </div>
              {links.length > 0 ? (
                <div style={styles.quickLinks} aria-label={tr("browser.ntp.quickLinks")}>
                  {links.map((link) => {
                    const host = hostOf(link.url);
                    const letter = (link.title || host).trim().charAt(0).toUpperCase() || "·";
                    return (
                      <button
                        key={link.url}
                        type="button"
                        style={styles.quickLink}
                        title={link.url}
                        onClick={() => onOpenUrl(link.url)}
                      >
                        <span style={styles.quickTile}>
                          {link.favicon ? <img src={link.favicon} alt="" width={22} height={22} style={styles.quickFavicon} /> : letter}
                        </span>
                        <span style={styles.quickLabel}>{link.title}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <h1 style={styles.ntpTitle}>{tr("browser.ntp.vibeTitle")}</h1>
              <VibeComposer
                draft={draft}
                onDraftChange={onDraftChange}
                onKeyDown={onKeyDown}
                modelLabel={modelLabel}
                modelGroups={modelGroups}
                onChooseModel={onChooseModel}
                effortOptions={effortOptions}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                effortLabel={effortLabel}
                chatBuildMode={chatBuildMode}
                onToggleBuildMode={onToggleBuildMode}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelectWorkspace={onSelectWorkspace}
                onAddWorkspace={onAddWorkspace}
                onOpenWorkspacePanel={onOpenWorkspacePanel}
                onAttach={onAttach}
                browserControl={browserControl}
                onToggleBrowserControl={onToggleBrowserControl}
                onSend={onSubmitVibe}
                busy={false}
                hint={tr("browser.ntp.vibeHint")}
                placeholder={tr("browser.ntp.vibePlaceholder")}
                testIdPrefix="ntp-vibe"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Vibecoding 会话页 ───────────────────────────── */

interface VibeChatViewProps extends StartPageProps {
  onAttach: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

function VibeChatView({
  messages,
  chatMode,
  busy,
  contextUsed,
  contextCap,
  contextPct,
  thinkingOpen,
  onToggleThinking,
  onRollback,
  onRegenerate,
  modelLabel,
  modelGroups,
  onChooseModel,
  onOpenUrl,
  onStop,
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  chatBuildMode,
  onToggleBuildMode,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onAttach,
  browserControl,
  onToggleBrowserControl,
  draft,
  onDraftChange,
  onSend,
}: VibeChatViewProps): React.JSX.Element {
  const tr = useT();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    autoGrow(textareaRef.current);
  }, [draft]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!busy) onSend();
  };

  return (
    <div style={styles.chatView} data-browser-state="chat">
      {/* 不能套一层 overflow 滚动容器：MessageList 自己是滚动容器，TopicRail（卷轴）按它的高度绝对定位绘制。 */}
      <div style={styles.chatScroll}>
        {messages.length === 0 ? (
          <div style={styles.chatEmpty}>{tr("browser.ntp.vibeEmpty")}</div>
        ) : (
          <MessageList
            messages={messages}
            mode={chatMode}
            contextUsed={contextUsed}
            contextCap={contextCap}
            contextPct={contextPct}
            thinkingOpen={thinkingOpen}
            onToggleThinking={onToggleThinking}
            onRollback={onRollback}
            onRegenerate={onRegenerate}
            onOpenUrl={onOpenUrl}
          />
        )}
      </div>
      {/* 发送栏：从新标签页中间位置「下移」到页面底部（CSS 几何入场动画） */}
      <div style={styles.chatComposerWrap} className="vibe-composer-drop">
        <div style={styles.chatComposerBox}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
              autoGrow(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            placeholder={tr("browser.ntp.chatPlaceholder")}
            aria-label={tr("browser.ntp.chatPlaceholder")}
            rows={1}
            style={styles.chatTextarea}
            data-testid="vibe-chat-input"
          />
          <div style={styles.chatBar}>
            <VibeControls
              compact
              modelLabel={modelLabel}
              modelGroups={modelGroups}
              onChooseModel={onChooseModel}
              effortOptions={effortOptions}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={onReasoningEffortChange}
              effortLabel={effortLabel}
              chatBuildMode={chatBuildMode}
              onToggleBuildMode={onToggleBuildMode}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onSelectWorkspace={onSelectWorkspace}
              onAddWorkspace={onAddWorkspace}
              onAttach={onAttach}
              browserControl={browserControl}
              onToggleBrowserControl={onToggleBrowserControl}
            />
            <span style={styles.spacer} />
            {busy ? (
              <button type="button" className="icon-btn" style={styles.sendBtn} title={tr("browser.ntp.stop")} aria-label={tr("browser.ntp.stop")} onClick={onStop}>
                <Icon name="stop" size={15} />
              </button>
            ) : (
              <button type="button" className="icon-btn" style={styles.sendBtn} title={tr("browser.ntp.send")} aria-label={tr("browser.ntp.send")} onClick={onSend} disabled={!draft.trim()}>
                <Icon name="send" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 共用输入块 / 模型胶囊 ───────────────────────────── */

interface VibeComposerProps extends VibeControlsProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  busy: boolean;
  hint: string;
  placeholder: string;
  testIdPrefix: string;
}

function VibeComposer({
  draft,
  onDraftChange,
  onKeyDown,
  onSend,
  busy,
  hint,
  placeholder,
  testIdPrefix,
  ...controls
}: VibeComposerProps): React.JSX.Element {
  const tr = useT();
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    autoGrow(ref.current);
  }, [draft]);
  return (
    <>
      <div style={styles.vibeBox} data-testid="vibe-composer-box">
      <textarea
        ref={ref}
        value={draft}
        onChange={(event) => {
          onDraftChange(event.target.value);
          autoGrow(event.currentTarget);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        style={styles.vibeTextarea}
        data-testid={`${testIdPrefix}-input`}
        autoFocus
      />
      <div style={styles.vibeBar}>
        <VibeControls {...controls} />
        <span style={styles.vibeHint}>{hint}</span>
        <span style={styles.spacer} />
        <button
          type="button"
          className="icon-btn"
          style={styles.sendBtn}
          title={busy ? "停止" : "发送"}
          aria-label="发送"
          onClick={onSend}
          disabled={!draft.trim() || busy}
          data-testid={`${testIdPrefix}-send`}
        >
          <Icon name={busy ? "stop" : "send"} size={16} />
        </button>
      </div>
      </div>
      <div style={styles.vibeWorkspaceRow}>
        <VibeWorkspacePicker
          workspaces={controls.workspaces}
          activeWorkspaceId={controls.activeWorkspaceId}
          onSelectWorkspace={controls.onSelectWorkspace}
          onAddWorkspace={controls.onAddWorkspace}
          onOpenWorkspacePanel={controls.onOpenWorkspacePanel}
        />
        {/* 会话级「浏览器控制」开关：与工作区选择同行、位于其右侧；开启时品牌色高亮 */}
        <button
          type="button"
          style={{ ...styles.vibeBrowserChip, ...(controls.browserControl ? styles.vibeBrowserChipOn : null) }}
          title={tr("composer.browserControlHint")}
          aria-pressed={controls.browserControl}
          aria-label={controls.browserControl ? tr("composer.browserControlOn") : tr("composer.browserControl")}
          data-testid="vibe-browser-chip"
          onClick={controls.onToggleBrowserControl}
        >
          <Icon name="globe" size={11} style={{ marginRight: 4 }} />
          {tr("composer.browserControl")}
        </button>
      </div>
    </>
  );
}

function VibeModelChip({
  modelLabel,
  modelGroups,
  onChooseModel,
  compact,
}: {
  modelLabel: string;
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  compact?: boolean;
}): React.JSX.Element {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  /** 胶囊在视口里的位置：菜单用 fixed + portal 挂到 body，彻底脱离页面内的层叠上下文。 */
  const [anchor, setAnchor] = React.useState<{ left: number; bottom: number } | null>(null);
  const chipRef = React.useRef<HTMLButtonElement | null>(null);
  usePopover("vibe-model-chip", open, setOpen);

  const toggleMenu = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor({ left, bottom: window.innerHeight - rect.top + 8 });
    setOpen(true);
  };
  return (
    <span style={styles.modelChipWrap}>
      <button
        ref={chipRef}
        type="button"
        style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr("browser.ntp.modelChipTitle", { model: modelLabel })}
        data-testid="vibe-model-chip"
        data-popover-trigger
      >
        <Icon name="bolt" size={11} style={styles.modelChipIcon} />
        <span style={styles.controlChipText}>{modelLabel}</span>
      </button>
      {open && anchor && typeof document !== "undefined"
        ? createPortal(
        <div
          style={{ ...styles.modelMenu, position: "fixed", left: anchor.left, bottom: anchor.bottom, zIndex: 1000 }}
          data-popover
          data-vibe-model-menu
          role="menu"
        >
          {modelGroups === null ? (
            <div style={styles.modelMenuNote}>{tr("browser.ntp.modelLoading")}</div>
          ) : modelGroups.length === 0 ? (
            <div style={styles.modelMenuNote}>{tr("browser.ntp.modelEmpty")}</div>
          ) : (
            modelGroups.map((group) => (
              <div key={group.providerId} style={styles.modelGroup}>
                <div style={styles.modelGroupHead}>
                  <span>{group.provider}</span>
                  {group.plan ? <span style={styles.modelGroupPlan}>{group.plan === "go" ? "Go" : "Zen"}</span> : null}
                </div>
                {group.models.map((model) => (
                  <button
                    key={`${group.providerId}:${model.id}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={false}
                    style={styles.modelItem}
                    onClick={() => {
                      onChooseModel(model.id, group.providerId);
                      setOpen(false);
                    }}
                  >
                    {model.id}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>,
        document.body,
      )
        : null}
    </span>
  );
}


/* ───────────────────────────── Vibecoding 控制条 ───────────────────────────── */

interface VibeControlsProps {
  modelLabel: string;
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  effortOptions: string[];
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  effortLabel: (value: string) => string;
  chatBuildMode: "build" | "plan";
  onToggleBuildMode: () => void;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /** 选择附件后插入当前输入草稿。 */
  onAttach: () => void;
  /** 会话级「浏览器控制」开关（关闭时 browser_* 工具对模型不可见）。 */
  browserControl: boolean;
  onToggleBrowserControl: () => void;
  /** 工作区「更多」：打开详细工作区面板（WorkspacePanel）。 */
  onOpenWorkspacePanel?: () => void;
  compact?: boolean;
}

interface MenuAnchor {
  left: number;
  /** 向上展开：距视口底部的距离（菜单贴住触发器上方）。 */
  bottom?: number;
  /** 向下展开：菜单顶部位置（贴住触发器下方）。 */
  top?: number;
}

/** 浮层菜单锚点：固定在触发器上方、夹在视口内（与模型菜单同款，避免被页内层叠上下文影响）。 */
function useFloatingMenu(width: number, direction: "up" | "down" = "up"): {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  anchor: MenuAnchor | null;
  open: boolean;
  toggle: () => void;
  close: () => void;
} {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = React.useState<MenuAnchor | null>(null);
  const [open, setOpen] = React.useState(false);
  const close = (): void => {
    setOpen(false);
    setAnchor(null);
  };
  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor(
      direction === "down"
        ? { left, top: rect.bottom + 8 }
        : { left, bottom: window.innerHeight - rect.top + 8 },
    );
    setOpen(true);
  };
  return { triggerRef, anchor, open, toggle, close };
}

function FloatingMenu({
  anchor,
  width,
  children,
}: {
  anchor: MenuAnchor | null;
  width: number;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (!anchor || typeof document === "undefined") return null;
  const downStyle =
    anchor.top !== undefined
      ? { top: anchor.top, maxHeight: Math.max(120, window.innerHeight - anchor.top - 12), overflowY: "auto" as const }
      : { bottom: anchor.bottom };
  return createPortal(
    <div data-popover role="menu" style={{ ...styles.floatingMenu, left: anchor.left, ...downStyle, width }}>
      {children}
    </div>,
    document.body,
  );
}

function VibeControls(props: VibeControlsProps): React.JSX.Element {
  return (
    <span style={styles.controls} data-testid="vibe-controls">
      <PlusControl {...props} />
      <VibeModelChip modelLabel={props.modelLabel} modelGroups={props.modelGroups} onChooseModel={props.onChooseModel} compact={props.compact} />
      {props.effortOptions.length > 0 ? <EffortControl {...props} /> : null}
      <ModeControl chatBuildMode={props.chatBuildMode} onToggleBuildMode={props.onToggleBuildMode} compact={props.compact} />
    </span>
  );
}

/** 输入框下方的工作区选择按钮（Vibecoding 页）：展开已有工作区 + 最下面「添加工作区」。 */
function VibeWorkspacePicker({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onOpenWorkspacePanel,
}: Pick<VibeControlsProps, "workspaces" | "activeWorkspaceId" | "onSelectWorkspace" | "onAddWorkspace" | "onOpenWorkspacePanel">): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(240, "down");
  usePopover("vibe-workspace-picker", menu.open, (next) => {
    if (!next) menu.close();
  });
  const active = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        style={styles.workspacePickChip}
        data-popover-trigger
        title={active ? tr("browser.vibe.workspaceCurrent", { name: active.name }) : tr("browser.vibe.workspaceChoose")}
        aria-label={tr("browser.vibe.workspaceChoose")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        data-testid="vibe-workspace-picker"
      >
        <Icon name="folder" size={11} style={{ marginRight: 4 }} />
        <span style={styles.workspacePickText}>{active ? active.name : tr("browser.vibe.workspaceChoose")}</span>
        <Icon name="chevron-down" size={10} style={{ marginLeft: 3, opacity: 0.65 }} />
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={240}>
          <div style={styles.menuTitle}>{tr("browser.vibe.workspaceMenuTitle")}</div>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              style={styles.menuItem}
              title={workspace.root}
              onClick={() => {
                onSelectWorkspace(workspace.id);
                menu.close();
              }}
            >
              <Icon name={workspace.id === activeWorkspaceId ? "check" : "folder"} size={12} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{workspace.name}</span>
            </button>
          ))}
          <div style={styles.menuDivider} />
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAddWorkspace();
            }}
            data-testid="vibe-workspace-picker-add"
          >
            <Icon name="workspace-add" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("chat.addWorkspace")}</span>
          </button>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onOpenWorkspacePanel?.();
            }}
            data-testid="vibe-workspace-picker-more"
          >
            <Icon name="more" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("browser.vibe.workspaceMore")}</span>
          </button>
        </FloatingMenu>
      ) : null}
    </span>
  );
}

/**
 * 圆形「+」：与右侧会话输入区同款（Composer.plusBtn）；菜单 = 工作区（切换/选择文件夹）
 * + 更多操作（附件、会话级「浏览器控制」开关）。附件不再是独立按钮，统一折叠进这里。
 */
function PlusControl({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onAttach,
  browserControl,
  onToggleBrowserControl,
}: VibeControlsProps): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(240);
  usePopover("vibe-workspace-menu", menu.open, (next) => {
    if (!next) menu.close();
  });
  const active = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="composer-plus vibe-plus"
        style={styles.vibePlusBtn}
        data-popover-trigger
        title={active ? tr("browser.vibe.workspaceCurrent", { name: active.name }) : tr("browser.vibe.workspaceChoose")}
        aria-label={tr("browser.vibe.workspaceChoose")}
        onClick={menu.toggle}
        data-testid="vibe-plus"
      >
        <Icon name="plus" size={14} />
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={240}>
          <div style={styles.menuTitle}>{tr("browser.vibe.workspaceMenuTitle")}</div>
          {workspaces.length === 0 ? <div style={styles.menuEmpty}>{tr("browser.vibe.workspaceEmpty")}</div> : null}
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              style={styles.menuItem}
              title={workspace.root}
              onClick={() => {
                onSelectWorkspace(workspace.id);
                menu.close();
              }}
            >
              <Icon name={workspace.id === activeWorkspaceId ? "check" : "folder"} size={12} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{workspace.name}</span>
            </button>
          ))}
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAddWorkspace();
            }}
            data-testid="vibe-workspace-add"
          >
            <Icon name="folder" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("browser.vibe.workspaceAdd")}</span>
          </button>
          <div style={styles.menuDivider} />
          <div style={styles.menuTitle}>{tr("composer.moreActions")}</div>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAttach();
            }}
            data-testid="vibe-attach"
          >
            <Icon name="paperclip" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("composer.attachLabel")}</span>
          </button>
        </FloatingMenu>
      ) : null}
    </span>
  );
}
function EffortControl({
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  compact,
}: VibeControlsProps): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(180);
  usePopover("vibe-effort-menu", menu.open, (next) => {
    if (!next) menu.close();
  });
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
        data-popover-trigger
        title={tr("browser.vibe.effortTitle")}
        onClick={menu.toggle}
        data-testid="vibe-effort-chip"
      >
        <Icon name="bolt" size={11} />
        <span style={styles.controlChipText}>{effortLabel(reasoningEffort)}</span>
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={180}>
          <div style={styles.menuTitle}>{tr("browser.vibe.effortMenuTitle")}</div>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              onReasoningEffortChange("");
              menu.close();
            }}
          >
            <Icon name={reasoningEffort === "" ? "check" : "circle"} size={11} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{effortLabel("")}</span>
          </button>
          {effortOptions.map((value) => (
            <button
              key={value}
              type="button"
              style={styles.menuItem}
              onClick={() => {
                onReasoningEffortChange(value);
                menu.close();
              }}
            >
              <Icon name={reasoningEffort === value ? "check" : "circle"} size={11} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{effortLabel(value)}</span>
            </button>
          ))}
        </FloatingMenu>
      ) : null}
    </span>
  );
}

function ModeControl({
  chatBuildMode,
  onToggleBuildMode,
  compact,
}: {
  chatBuildMode: "build" | "plan";
  onToggleBuildMode: () => void;
  compact?: boolean;
}): React.JSX.Element {
  const tr = useT();
  const isPlan = chatBuildMode === "plan";
  return (
    <button
      type="button"
      style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
      title={tr("browser.vibe.modeTitle", { mode: isPlan ? tr("browser.vibe.modePlan") : tr("browser.vibe.modeBuild") })}
      onClick={onToggleBuildMode}
      data-testid="vibe-mode-chip"
    >
      <Icon name={isPlan ? "notes" : "bolt"} size={11} />
      <span style={styles.controlChipText}>{isPlan ? tr("browser.vibe.modePlan") : tr("browser.vibe.modeBuild")}</span>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  browserPane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // 网页面板：四边留白 + 圆角 + 裁切，与原生 WebContentsView 的 inset/圆角共用同一契约值，
    // 页面不再顶到窗口边缘（用户反馈的「硬朗直角」）；右侧紧邻会话栏，单独收窄到 4px。
    margin: `${LAYOUT.BROWSER_VIEW_INSET}px ${LAYOUT.BROWSER_VIEW_INSET_RIGHT}px ${LAYOUT.BROWSER_VIEW_INSET}px ${LAYOUT.BROWSER_VIEW_INSET}px`,
    borderRadius: LAYOUT.BROWSER_VIEW_RADIUS,
    overflow: "hidden",
    boxSizing: "border-box",
    background: `radial-gradient(circle at 28% 18%, rgba(var(--ls-accent-rgb, 200, 118, 60),0.10) 0%, ${BRAND.ink} 58%)`,
  },
  statePane: {
    width: "100%",
    maxWidth: 560,
    padding: 28,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    animation: "fadeUp 200ms ease both",
  },
  loadingLogoWrap: { marginBottom: 16 },
  loadingTitle: { fontSize: 18, fontWeight: 700, color: BRAND.linen, letterSpacing: 0.2 },
  loadingTarget: {
    marginTop: 8,
    fontSize: 12.5,
    color: BRAND.ochreHover,
    fontFamily: "ui-monospace, Consolas, monospace",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  loadingBar: {
    position: "relative",
    width: 220,
    height: 3,
    marginTop: 22,
    borderRadius: 999,
    background: "rgba(255,255,255,0.07)",
    overflow: "hidden",
  },
  loadingBarFill: {
    position: "absolute",
    inset: "0 auto 0 0",
    width: "38%",
    borderRadius: 999,
    background: `linear-gradient(90deg, transparent, ${BRAND.ochre}, ${BRAND.ochreHover})`,
  },
  loadingHint: { marginTop: 14, fontSize: 11.5, color: BRAND.linenFaint },

  errorIconWrap: {
    width: 84,
    height: 84,
    marginBottom: 18,
    borderRadius: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(248,113,113,0.08)",
    border: "1px solid rgba(248,113,113,0.22)",
    color: "#f87171",
  },
  errorIcon: { opacity: 0.95 },
  errorTitle: { fontSize: 18, fontWeight: 700, color: BRAND.linen },
  errorDesc: { marginTop: 8, fontSize: 12.5, color: BRAND.linenMuted, lineHeight: 1.7, maxWidth: 460 },
  errorTarget: {
    marginTop: 12,
    fontSize: 11.5,
    color: BRAND.linenFaint,
    fontFamily: "ui-monospace, Consolas, monospace",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  errorCode: { marginTop: 6, fontSize: 10.5, color: "rgba(248,113,113,0.75)", fontFamily: "ui-monospace, Consolas, monospace" },
  errorActions: { marginTop: 20, display: "flex", gap: 10, alignItems: "center" },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 16px",
    borderRadius: 8,
    border: "1px solid rgba(200,118,60,0.55)",
    background: "rgba(200,118,60,0.16)",
    color: BRAND.ochreHover,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryBtn: { height: 30, padding: "0 14px", borderRadius: 8, fontSize: 12.5 },
  btnIcon: { marginTop: -1 },
  errorHint: { marginTop: 22, fontSize: 11, color: BRAND.linenFaint, lineHeight: 1.7, maxWidth: 420 },

  /* ── 新建标签页 ── */
  ntp: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
    overflowY: "auto",
  },
  ntpInner: { width: "100%", maxWidth: 720, display: "flex", flexDirection: "column", alignItems: "center" },
  brandRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 18, opacity: 0.95 },
  brandName: { fontSize: 18, fontWeight: 800, letterSpacing: 0.4, color: BRAND.linen },
  modeToggle: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    width: 240,
    padding: 3,
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
    marginBottom: 22,
    boxSizing: "border-box",
  },
  modeThumb: {
    position: "absolute",
    top: 3,
    left: 3,
    width: "calc(50% - 3px)",
    height: "calc(100% - 6px)",
    borderRadius: 999,
    background: "rgba(200,118,60,0.20)",
    border: "1px solid rgba(200,118,60,0.42)",
    transition: "transform 220ms cubic-bezier(0.2,0,0.2,1)",
    boxSizing: "border-box",
  },
  modeBtn: {
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "1 1 0",
    minWidth: 0,
    gap: 6,
    height: 30,
    padding: 0,
    lineHeight: 1,
    whiteSpace: "nowrap",
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 999,
    cursor: "pointer",
    transition: "color 160ms ease",
  },
  modeBtnActive: { color: BRAND.ochreHover },
  modeBtnIcon: { marginTop: -1 },
  // 固定最小高度：搜索态/ Vibecoding 态内容块等高，切换时居中布局不会瞬时上下跳动（视频逐帧看到的一帧错位根因）。
  modeBody: { width: "100%", minHeight: 204, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start" },
  ntpTitle: { margin: "4px 0 20px", fontSize: 30, fontWeight: 800, letterSpacing: 0.3, color: BRAND.linen, textAlign: "center" },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 52,
    padding: "0 8px 0 18px",
    borderRadius: 16,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxSizing: "border-box",
    boxShadow: "0 10px 34px rgba(0,0,0,0.28)",
  },
  searchEngineIcon: { flex: "none", borderRadius: 5 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 15,
  },
  searchSubmit: { width: 38, height: 38, flex: "none", borderRadius: 12, background: "rgba(200,118,60,0.16)", color: BRAND.ochreHover },
  quickLinks: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
    gap: 8,
    width: "100%",
    maxWidth: 620,
    marginTop: 22,
  },
  quickLink: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 7,
    padding: "10px 6px",
    borderRadius: 12,
    border: `1px solid transparent`,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    transition: "background 120ms ease, border-color 120ms ease",
  },
  quickTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: BRAND.inkRaised,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.ochreHover,
    fontSize: 17,
    fontWeight: 700,
  },
  quickFavicon: { borderRadius: 4, objectFit: "contain" },
  quickLabel: {
    width: "100%",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "center",
  },

  /* ── Vibecoding 输入块 ── */
  vibeWorkspaceRow: { display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 6, width: "100%", maxWidth: 720, marginTop: 6 },
  /** 「浏览器控制」胶囊（关闭态中性、开启态品牌色），与工作区选择同行。 */
  vibeBrowserChip: {
    display: "inline-flex",
    alignItems: "center",
    height: 26,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 600,
    color: BRAND.linenMuted,
    background: "transparent",
    border: "1px solid transparent",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
    transition: "background 120ms, color 120ms, border-color 120ms",
  },
  vibeBrowserChipOn: {
    color: BRAND.ochreHover,
    background: BRAND.ochreSoft,
    border: "1px solid rgba(200,118,60,0.55)",
  },
  workspacePickChip: {
    height: 26,
    padding: "0 10px",
    fontSize: 11.5,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    maxWidth: 240,
    color: BRAND.ochreHover,
    background: BRAND.ochreSoft,
    border: "1px solid rgba(200,118,60,0.55)",
    borderRadius: 999,
    boxShadow: "0 2px 10px rgba(200,118,60,0.12)",
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms, color 120ms",
  },
  workspacePickText: { maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  vibeBox: {
    width: "100%",
    maxWidth: 720,
    padding: 14,
    borderRadius: 18,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxSizing: "border-box",
    boxShadow: "0 16px 44px rgba(0,0,0,0.30)",
  },
  vibeTextarea: {
    width: "100%",
    minHeight: 24,
    maxHeight: 152,
    padding: "2px 4px",
    border: "none",
    outline: "none",
    resize: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 14,
    lineHeight: 1.6,
    boxSizing: "border-box",
  },
  vibeBar: { display: "flex", alignItems: "center", gap: 10, marginTop: 10 },
  vibeHint: { fontSize: 10.5, color: BRAND.linenFaint, flex: "none" },
  vibeFoot: { marginTop: 14, fontSize: 11, color: BRAND.linenFaint, textAlign: "center", lineHeight: 1.7 },
  spacer: { flex: 1 },
  sendBtn: {
    width: 34,
    height: 34,
    flex: "none",
    borderRadius: 10,
    background: "rgba(200,118,60,0.18)",
    color: BRAND.ochreHover,
  },

  /* ── 模型胶囊 ── */
  modelChipWrap: { position: "relative", display: "inline-flex", alignItems: "center" },
  modelChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    maxWidth: 260,
  },
  modelChipCompact: { height: 24, fontSize: 11 },
  modelChipIcon: { color: BRAND.ochreHover, flex: "none" },
  modelChipText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelChipMore: { color: BRAND.linenFaint, flex: "none" },
  modelMenu: {
    position: "absolute",
    bottom: 32,
    left: 0,
    zIndex: 60,
    width: 320,
    maxHeight: 320,
    overflowY: "auto",
    padding: 6,
    borderRadius: 12,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
    animation: "fadeUp 120ms ease both",
  },
  modelMenuNote: { padding: 12, fontSize: 11.5, color: BRAND.linenFaint },
  modelGroup: { padding: "4px 2px 6px" },
  modelGroupHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    fontSize: 10.5,
    fontWeight: 700,
    color: BRAND.linenFaint,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  modelGroupPlan: {
    fontSize: 9,
    padding: "0 5px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.ochreHover,
  },
  modelItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "6px 9px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  /* ── Vibecoding 会话页 ── */
  chatView: { width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 },
  chatScroll: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "6px 0 6px 8px", boxSizing: "border-box", animation: "vibePageIn 260ms ease both" },
  chatEmpty: { marginTop: 80, textAlign: "center", color: BRAND.linenFaint, fontSize: 13 },
  chatComposerWrap: {
    flexShrink: 0,
    width: "100%",
    padding: "8px 18px 16px",
    boxSizing: "border-box",
    display: "flex",
    justifyContent: "center",
  },
  chatComposerBox: {
    width: "100%",
    maxWidth: 860,
    padding: "12px 14px",
    borderRadius: 18,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxSizing: "border-box",
    boxShadow: "0 16px 44px rgba(0,0,0,0.30)",
  },

  controls: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  menuWrap: { position: "relative", display: "inline-flex" },
  /** 统一胶囊：所有控制项同高/同底/同边框，不再有深/浅混搭与被截断的省略号。 */
  controlChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 24,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.045)",
    color: BRAND.linenMuted,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    flex: "none",
  },
  controlChipCompact: { height: 22 },
  controlChipText: { whiteSpace: "nowrap" },
  /** 圆形加号（与右侧会话输入区同款）：常态只有一个圆框加号。 */
  vibePlusBtn: {
    width: 26,
    height: 26,
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    borderRadius: "50%",
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms, color 120ms",
    boxSizing: "border-box",
  },
  floatingMenu: {
    position: "fixed",
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 6,
    borderRadius: 12,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
    animation: "fadeUp 120ms ease both",
  },
  menuTitle: { padding: "4px 8px 6px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: BRAND.linenFaint, textTransform: "uppercase" },
  menuEmpty: { padding: "6px 8px 8px", fontSize: 11.5, color: BRAND.linenFaint },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
  },
  menuItemIcon: { flex: "none", color: BRAND.linenFaint },
  menuItemText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menuDivider: { height: 1, margin: "4px 2px", background: BRAND.border },

  chatTextarea: {
    width: "100%",
    minHeight: 24,
    maxHeight: 152,
    padding: "2px 4px",
    border: "none",
    outline: "none",
    resize: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 13.5,
    lineHeight: 1.6,
    boxSizing: "border-box",
  },
  chatBar: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
};
