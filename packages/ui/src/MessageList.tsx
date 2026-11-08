/**
 * 会话消息列表：滚动跟随（锁定最新）+ 卷轴 + 单条消息渲染。
 *
 * 跟随逻辑移植 slime 的成熟结论（并抽成纯判据 `scrollFollow.ts`）：
 *   · 用户滚轮上滚 = 立即解除跟随（不受"程序每帧拉底"抵消）；
 *   · 距离判据带滞回（>48px 松开，≤8px 恢复），避免边界抽搐；
 *   · 内容高度变化用 ResizeObserver + MutationObserver 驱动的 rAF 循环贴底，折叠展开也跟随；
 *   · 内层可滚元素（代码块 pre）自己滚时不解除外层跟随；
 *   · 用户上翻后显示「回到最新」按钮，点击恢复跟随。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import TopicRail from "./TopicRail.js";
import ChatMessageView from "./ChatMessageView.js";
import type { ChatMessage } from "./chatStreamState.js";
import { decideFollow, hasInnerScroller, shouldRestickAfterResize, type ScrollBox } from "./scrollFollow.js";
import { useT } from "./i18n.js";

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
  const tr = useT();
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const atBottomRef = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);
  const scrollRafRef = React.useRef<number | null>(null);

  /** 滚轮是最可靠的意图信号：向上立即解除跟随，向下且已到底则恢复。 */
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const scroller = scrollerRef.current;
    if (!scroller || event.deltaY === 0) return;
    if (event.deltaY > 0) {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (gap > 8 || atBottomRef.current) return;
      atBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    // 内层代码块自己滚：不解除外层跟随
    const ancestors: ScrollBox[] = [];
    for (let node = event.target as Element | null; node && node !== scroller; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) break;
      ancestors.push({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        overflowY: getComputedStyle(node).overflowY,
      });
    }
    if (hasInnerScroller(ancestors)) return;
    if (!atBottomRef.current) return;
    atBottomRef.current = false;
    setAtBottom(false);
  };

  /** 拖滚动条 / PageUp / 触屏等不产生 wheel 的上翻，用滞回判据兜底。 */
  const handleScroll = (): void => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const next = decideFollow({
        top: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        following: atBottomRef.current,
      });
      atBottomRef.current = next;
      setAtBottom((current) => (current === next ? current : next));
    });
  };

  const jumpToLatest = (): void => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };

  /** 内容高度变化就保持贴底（含折叠展开/图片迟加载），静默片刻停表。 */
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    let running = false;
    let syncRaf = 0;
    let lastHeight = -1;
    let stableFrames = 0;
    const IDLE_FRAMES = 20;
    const tick = (): void => {
      const element = scrollerRef.current;
      if (!element || !atBottomRef.current) {
        running = false;
        return;
      }
      const height = element.scrollHeight;
      // 内容变高（流式/折叠）或容器被顶矮（终端抽屉展开）都要补到底；
      // 只在"仍在跟随"时补 —— 用户已上翻时 tick 开头已提前退出，不会抢滚动位置。
      const needsRestick = shouldRestickAfterResize({
        top: element.scrollTop,
        scrollHeight: height,
        clientHeight: element.clientHeight,
        following: atBottomRef.current,
      });
      if (height !== lastHeight || needsRestick) {
        lastHeight = height;
        stableFrames = 0;
        element.scrollTop = height;
      } else if (++stableFrames >= IDLE_FRAMES) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    const kick = (): void => {
      if (running || !atBottomRef.current) return;
      running = true;
      stableFrames = 0;
      lastHeight = -1;
      raf = requestAnimationFrame(tick);
    };
    const resizeObserver = new ResizeObserver(kick);
    // 容器自身高度变化也要补底：只观察消息子节点时，终端抽屉展开把聊天区压矮，
    // 子节点高度不变 → 不会 kick，最新消息就被顶出视口（用户反馈的"终端一展开就看不到最新回复"）。
    resizeObserver.observe(scroller);
    const observed = new Set<Element>();
    const sync = (): void => {
      const element = scrollerRef.current;
      if (!element) return;
      for (const child of Array.from(element.children)) {
        if (!observed.has(child)) {
          resizeObserver.observe(child);
          observed.add(child);
        }
      }
      for (const child of Array.from(observed)) {
        if (!child.isConnected) {
          resizeObserver.unobserve(child);
          observed.delete(child);
        }
      }
      kick();
    };
    sync();
    const mutationObserver = new MutationObserver(() => {
      if (syncRaf) return;
      syncRaf = requestAnimationFrame(() => {
        syncRaf = 0;
        sync();
      });
    });
    mutationObserver.observe(scroller, { childList: true, subtree: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(syncRaf);
    };
  }, []);

  /** 首批历史/新消息渲染后：布局稳定地贴底（图片/异步 Markdown 增高也能落到底）。 */
  React.useEffect(() => {
    if (!atBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages.length]);

  return (
    <div style={styles.messageArea}>
      <div
        ref={scrollerRef}
        className="chat-scroll"
        style={styles.messageList}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {messages.length === 0 ? (
          <div style={styles.emptyHint}>{tr("chat.emptyHint")}</div>
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
      <div className={`scroll-fade-mask is-bottom${atBottom ? " is-hidden" : ""}`} aria-hidden />
      {!atBottom ? (
        <button type="button" className="jump-latest" title={tr("chat.jumpLatest")} onClick={jumpToLatest}>
          {tr("chat.jumpLatest")}
        </button>
      ) : null}
      <TopicRail scroller={() => scrollerRef.current} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  messageArea: { position: "relative", flex: 1, minHeight: 0, display: "flex" },
  // 会话内容整体再收窄几像素（用户 m04830）：右侧 padding 20→24px，让气泡/代码块与卷轴
  // 之间有更明显的呼吸感；卷轴绝对定位、不受影响，头部与输入框也不在列表内。
  messageList: { flex: 1, overflowY: "auto", padding: "12px 24px 12px 14px", display: "flex", flexDirection: "column", gap: 12 },
  emptyHint: { color: BRAND.linenFaint, fontSize: 12.5, lineHeight: 1.8, paddingTop: 24 },
};
