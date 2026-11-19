import * as React from "react";
import StatusBar from "./StatusBar.js";

const TerminalPanel = React.lazy(() => import("./TerminalPanel.js"));

export interface AppBottomPanelsProps {
  miniWindow: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  devtoolsOpen: boolean;
  devtoolsHeight: number;
  currentSession: string | null;
  shellStatus?: string;
  agentLabel: string;
  providerLabel: string;
  currentUrl: string;
  mode: "build" | "plan";
  onCloseTerminal: () => void;
  onTerminalHeightChange: (height: number) => void;
  onTerminalResizeStart: () => void;
  onTerminalResizeEnd: () => void;
  onToggleTerminal: () => void;
  onToggleDevtools: () => void;
}

/**
 * 应用底部面板：全宽终端抽屉 + DevTools 占位槽。
 * 纯布局组件；开关/高度/主进程同步由 useBottomDock 负责。
 */
export default function AppBottomPanels({
  miniWindow,
  terminalOpen,
  terminalHeight,
  devtoolsOpen,
  devtoolsHeight,
  currentSession,
  shellStatus,
  agentLabel,
  providerLabel,
  currentUrl,
  mode,
  onCloseTerminal,
  onTerminalHeightChange,
  onTerminalResizeStart,
  onTerminalResizeEnd,
  onToggleTerminal,
  onToggleDevtools,
}: AppBottomPanelsProps) {
  return (
    <>
      {/* 应用内终端：全宽底部面板（VS Code 风格，从整个程序底部拉起） */}
      <div
        style={{
          height: terminalOpen ? terminalHeight : 0,
          flexShrink: 0,
          overflow: "hidden",
          transition: "height 240ms cubic-bezier(0.2, 0, 0.2, 1)",
        }}
      >
        <React.Suspense fallback={null}>
          <TerminalPanel
            sessionId={currentSession ?? undefined}
            open={terminalOpen}
            onClose={onCloseTerminal}
            height={terminalHeight}
            onHeightChange={onTerminalHeightChange}
            fullWidth
            onResizeStart={onTerminalResizeStart}
            onResizeEnd={onTerminalResizeEnd}
          />
        </React.Suspense>
      </div>

      {miniWindow ? null : (
        <StatusBar
          shellStatus={shellStatus}
          agentLabel={agentLabel}
          providerLabel={providerLabel}
          currentUrl={currentUrl}
          mode={mode}
          terminalOpen={terminalOpen}
          onToggleTerminal={onToggleTerminal}
          devtoolsOpen={devtoolsOpen}
          onToggleDevtools={onToggleDevtools}
        />
      )}

      {/* 底部开发者工具面板：占位放在状态栏之后 → 面板增高时状态栏被平滑推上去，
          成为展开面板的顶栏；真实 DevTools WebContentsView 由主进程覆盖在该区域上。 */}
      <div
        data-testid="devtools-panel-slot"
        aria-hidden={!devtoolsOpen}
        style={{
          height: devtoolsOpen ? devtoolsHeight : 0,
          flexShrink: 0,
          overflow: "hidden",
          transition: "height 240ms cubic-bezier(0.2, 0, 0.2, 1)",
        }}
      />
    </>
  );
}
