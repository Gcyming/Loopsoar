/** 新标签页：搜索 / Vibecoding 两种入口。 */
import * as React from "react";
import type { SearchEngine } from "loopsoar-contracts/omnibox";
import { Icon } from "./Icon.js";
import BrandWordmark from "./BrandWordmark.js";
import { useT } from "./i18n.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { autoGrow, hostOf } from "./startPageModel.js";
import { styles } from "./startPageStyles.js";
import { VibeControls, VibeWorkspacePicker } from "./VibeControls.js";
import type { VibeControlsProps } from "./VibeControls.js";
import type { StartPageProps } from "./startPageTypes.js";

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

export default function NewTabPage({
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
          <BrandWordmark size={18} weight={800} letterSpacing={0.4} style={styles.brandName} />
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
