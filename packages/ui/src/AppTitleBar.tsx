import * as React from "react";
import TitleBar from "./TitleBar.js";
import WorkspaceSwitcher from "./WorkspaceSwitcher.js";
import BrowserTabs from "./BrowserTabs.js";
import type { TabMenuAction } from "./BrowserTabs.js";
import { dismissAllPopovers } from "./popover.js";
import type { TabState, WorkspaceRecord } from "./types.js";

export interface AppTitleBarProps {
  maximized: boolean;
  miniWindow: boolean;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  userTabs: TabState[];
  boundTabs: TabState[];
  agentTasks: { sessionId: string; tabs: TabState[] }[];
  browserVisibleSession: string | null;
  currentSession: string | null;
  onToggleWorkspace: () => void;
  onCloseWorkspace: () => void;
  onOpenTask: (sessionId: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onTabAction: (action: TabMenuAction, tabId: string) => void;
  onOpenTabMenu: (tabId: string, anchor: { x: number; y: number; width: number; height: number }) => void;
  onNewTab: () => void;
}

/**
 * 顶部标题栏装配：窗口形态 + 工作区入口 + 标签条/Agent 任务条。
 * 纯展示组件；标签与会话状态仍由 App 持有。
 */
export default function AppTitleBar({
  maximized,
  miniWindow,
  workspaces,
  activeWorkspaceId,
  userTabs,
  boundTabs,
  agentTasks,
  browserVisibleSession,
  currentSession,
  onToggleWorkspace,
  onCloseWorkspace,
  onOpenTask,
  onSelectTab,
  onCloseTab,
  onTabAction,
  onOpenTabMenu,
  onNewTab,
}: AppTitleBarProps) {
  return (
    <TitleBar
      maximized={maximized}
      variant={miniWindow ? "agent" : "main"}
      {...(miniWindow
        ? {}
        : {
            tabsLeading: (
              <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
            ),
            tabs: (
              <BrowserTabs
                tabs={userTabs}
                boundTabs={boundTabs}
                onToggleWorkspace={() => {
                  // 独立浮层：网页保持原样（不隐藏、不被挤），浮层天然压在网页之上。
                  dismissAllPopovers();
                  onToggleWorkspace();
                }}
                onCloseWorkspace={onCloseWorkspace}
                agentTasks={agentTasks}
                currentSessionId={browserVisibleSession ?? currentSession}
                onOpenTask={onOpenTask}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onTabAction={onTabAction}
                onOpenTabMenu={onOpenTabMenu}
                onNewTab={onNewTab}
              />
            ),
          })}
    />
  );
}
