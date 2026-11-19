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
 *
 * 结构：StartPage（壳/加载/错误）→ StartPageNewTab（新标签页）/ StartPageChat（会话页）；
 * 共用输入控制条在 VibeControls.tsx，样式与 props 分别在 startPageStyles.ts / startPageTypes.ts。
 */

import * as React from "react";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { classifyLoadFailure, type BrowserFailureKind } from "./browserFailure.js";
import { hostOf } from "./startPageModel.js";
import { styles } from "./startPageStyles.js";
import NewTabPage from "./StartPageNewTab.js";
import VibeChatView from "./StartPageChat.js";
import type { StartPageProps } from "./startPageTypes.js";

export type { StartPageProps } from "./startPageTypes.js";

const FAILURE_VIEW: Record<BrowserFailureKind, { icon: string; titleKey: string; descKey: string }> = {
  offline: { icon: "offline", titleKey: "browser.error.offline.title", descKey: "browser.error.offline.desc" },
  dns: { icon: "globe", titleKey: "browser.error.dns.title", descKey: "browser.error.dns.desc" },
  refused: { icon: "link-off", titleKey: "browser.error.refused.title", descKey: "browser.error.refused.desc" },
  timeout: { icon: "clock", titleKey: "browser.error.timeout.title", descKey: "browser.error.timeout.desc" },
  ssl: { icon: "lock", titleKey: "browser.error.ssl.title", descKey: "browser.error.ssl.desc" },
  blocked: { icon: "shield-off", titleKey: "browser.error.blocked.title", descKey: "browser.error.blocked.desc" },
  generic: { icon: "warning", titleKey: "browser.error.generic.title", descKey: "browser.error.generic.desc" },
};

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
