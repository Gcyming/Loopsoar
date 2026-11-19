/** Vibecoding 会话页：复用 MessageList + 底部发送栏。 */
import * as React from "react";
import MessageList from "./MessageList.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { autoGrow } from "./startPageModel.js";
import { styles } from "./startPageStyles.js";
import { VibeControls } from "./VibeControls.js";
import type { StartPageProps } from "./startPageTypes.js";

/* ───────────────────────────── Vibecoding 会话页 ───────────────────────────── */

interface VibeChatViewProps extends StartPageProps {
  onAttach: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export default function VibeChatView({
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
  onFork,
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
            onFork={onFork}
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
