/**
 * StartPage 的公共 props（从 StartPage.tsx 抽出，避免子视图与主壳互相导入）。
 */
import type { SearchEngine } from "loopsoar-contracts/omnibox";
import type { BrowserLoadFailureInfo } from "./browserFailure.js";
import type { ChatMessage } from "./chatStreamState.js";
import type { ModelGroup } from "./modelGroups.js";
import type { WorkspaceRecord } from "./types.js";

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
  onFork: (id: string) => void;
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
