/**
 * 会话消息列表：滚动容器 + 自动滚底 + 卷轴（TopicRail）+ 单条消息渲染。
 *
 * 单一职责：只负责"把 messages 画出来并保持滚动位置"，不订阅事件、不做 IPC。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import TopicRail from "./TopicRail.js";
import ChatMessageView from "./ChatMessageView.js";
import type { ChatMessage } from "./chatStreamState.js";

export interface MessageListProps {
  messages: ChatMessage[];
  mode: "build" | "plan";
  contextUsed: number;
  contextCap: number;
  contextPct: number;
  thinkingOpen: Record<string, boolean>;
  expandAllGroups?: boolean;
  openProducts?: boolean;
  onToggleThinking: (id: string) => void;
  onRollback: (id: string) => void;
  onRegenerate: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

export default function MessageList({
  messages,
  mode,
  contextUsed,
  contextCap,
  contextPct,
  thinkingOpen,
  expandAllGroups = false,
  openProducts = false,
  onToggleThinking,
  onRollback,
  onRegenerate,
  onOpenUrl,
}: MessageListProps): React.ReactElement {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);
  return (
    <div style={styles.messageArea}>
      <div ref={scrollerRef} className="chat-scroll" style={styles.messageList}>
        {messages.length === 0 ? (
          <div style={styles.emptyHint}>和 Loopsoar 说点什么，例如「帮我总结当前网页」。</div>
        ) : (
          messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              mode={mode}
              contextUsed={contextUsed}
              contextCap={contextCap}
              contextPct={contextPct}
              thinkingOpen={thinkingOpen[message.id] ?? true}
              expandAllGroups={expandAllGroups}
              openProducts={openProducts}
              onToggleThinking={() => onToggleThinking(message.id)}
              onRollback={onRollback}
              onRegenerate={onRegenerate}
              onOpenUrl={onOpenUrl}
            />
          ))
        )}
      </div>
      <TopicRail scroller={() => scrollerRef.current} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  messageArea: { position: "relative", flex: 1, minHeight: 0, display: "flex" },
  messageList: { flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 },
  emptyHint: { color: BRAND.linenFaint, fontSize: 12.5, lineHeight: 1.8, paddingTop: 24 },
};
