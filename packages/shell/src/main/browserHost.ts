/**
 * BrowserHost：WebContentsView 生命周期与原生视图几何（依赖注入，零 electron import）。
 * 为什么独立于 electron：视图创建/挂载是 shell 的职责，但「何时导航、如何定位」是布局契约问题；
 * 拆开后可在测试里用假 View 验证行为（不启真窗口）。
 */
import {
  computeBrowserViewBounds,
  type BrowserViewBounds,
  type WindowSize,
} from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import {
  createWebContentsViewAdapter,
  type WebContentsViewLike,
} from "../browserAdapter/backends/webContentsView.js";
import type { BrowserAdapter, BrowserSnapshot } from "../browserAdapter/types.js";

/** 宿主要求的最小视图能力（WebContentsView 结构兼容 + 可定位）。 */
export interface HostView extends WebContentsViewLike {
  setBounds(bounds: BrowserViewBounds): void;
}

export interface BrowserHostDeps {
  createView: () => HostView;
  attachView: (view: HostView) => void;
  detachView: (view: HostView) => void;
  /** 内容区尺寸（不含窗口边框），用于计算原生视图包围盒。 */
  getWindowSize: () => WindowSize;
  onCreated?: (view: HostView) => void;
}

export type NavigateOutcome =
  | { ok: true; url: string }
  | { ok: false; error: string };

export class BrowserHost {
  private view: HostView | null = null;
  private adapter: BrowserAdapter | null = null;

  constructor(private deps: BrowserHostDeps) {}

  /** 懒创建：首次导航时才建 WebContentsView（启动不白占内存）。 */
  private ensure(): { view: HostView; adapter: BrowserAdapter } {
    if (!this.view || !this.adapter) {
      const view = this.deps.createView();
      const adapter = createWebContentsViewAdapter({ view });
      this.deps.attachView(view);
      this.view = view;
      this.adapter = adapter;
      this.deps.onCreated?.(view);
      this.syncBounds();
    }
    return { view: this.view, adapter: this.adapter };
  }

  hasView(): boolean {
    return this.view !== null;
  }

  /** 窗口缩放/布局变化时调用：把原生视图重新对齐到布局契约给出的区域。 */
  syncBounds(): void {
    if (!this.view) return;
    this.view.setBounds(computeBrowserViewBounds(this.deps.getWindowSize()));
  }

  /** 导航：URL 先过白名单校验（http/https），非法直接拒绝，不触碰视图。 */
  async navigate(rawUrl: string): Promise<NavigateOutcome> {
    const normalized = normalizeNavigateUrl(rawUrl);
    if (!normalized.ok) return { ok: false, error: normalized.reason };
    try {
      const { adapter } = this.ensure();
      const result = await adapter.navigate(normalized.url);
      this.syncBounds();
      return { ok: true, url: result.url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async snapshot(): Promise<BrowserSnapshot | null> {
    if (!this.adapter) return null;
    return this.adapter.snapshot();
  }

  async screenshot(): Promise<string | null> {
    if (!this.adapter) return null;
    return this.adapter.screenshot();
  }

  /** 关闭视图并从窗口摘除（视图销毁由外壳负责实例回收）。 */
  async close(): Promise<void> {
    const view = this.view;
    const adapter = this.adapter;
    if (!view || !adapter) return;
    this.view = null;
    this.adapter = null;
    try {
      await adapter.close();
    } finally {
      this.deps.detachView(view);
    }
  }
}
