/**
 * 渲染错误边界：任何组件在渲染时抛错，React 会卸载整棵子树。
 * 顶层使用（不传 fallback）→ 显示可读错误页 + 重新加载；
 * 局部使用（传 fallback）→ 只替换出错区域，其余界面继续可用。
 */
import * as React from "react";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 局部兜底：不传时显示整页错误页（顶层用）。 */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** 变化时自动清除错误（例如切换会话/标签）。 */
  resetKey?: string | number | null;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Loopsoar] 界面渲染出错：", error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    const error = this.state.error;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.title}>界面渲染出错</div>
          <div style={styles.message}>{error.message || String(error)}</div>
          <button type="button" style={styles.button} onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#111318",
    color: "#f3efe6",
    font: "13px/1.7 system-ui, 'Segoe UI', sans-serif",
    padding: 24,
  },
  card: {
    maxWidth: 560,
    width: "100%",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    padding: "20px 22px",
    background: "rgba(255,255,255,0.04)",
  },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
  message: {
    color: "rgba(243,239,230,0.72)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "50vh",
    overflow: "auto",
    marginBottom: 16,
  },
  button: {
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    background: "rgba(255,255,255,0.08)",
    color: "#f3efe6",
    padding: "7px 16px",
    cursor: "pointer",
  },
};
