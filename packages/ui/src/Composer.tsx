/**
 * 输入区（Composer）：多行输入 + Build/权限/模型/附件 chip + 模型菜单 + 推理等级 + 发送/停止。
 *
 * 纯展示 + 回调注入：所有业务动作（发送/转向/权限保存/模型切换）由 App 提供；
 * 组件的菜单开合是本地 UI 状态，不进入会话数据。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import type { PermissionsState, ProviderModel, ProviderStatus } from "./types.js";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
  mode: "build" | "plan";
  onToggleMode: () => void;
  compactUi: boolean;
  squeezeRatio: number;
  boxRef: React.RefObject<HTMLDivElement | null>;
  measureRef: React.RefObject<HTMLDivElement | null>;
  provider: ProviderStatus | null;
  permSummary: PermissionsState | null;
  onPermissionChange: (next: PermissionsState) => void;
  onOpenSettings: (section?: string) => void;
  modelMenuOpen: boolean;
  onOpenModelMenu: () => void;
  onCloseModelMenu: () => void;
  modelList: { models: ProviderModel[]; error: string | null } | null;
  onChooseModel: (modelId: string) => void;
  effortOptions: string[];
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  effortLabel: (value: string) => string;
  permissionLabel: (state: PermissionsState) => string;
  onPickAttachment: () => void;
  notice: string;
}

const PERMISSION_CATEGORIES = [
  { key: "read", label: "读取文件" },
  { key: "write", label: "写入文件" },
  { key: "terminal", label: "执行命令" },
  { key: "network", label: "网络访问" },
] as const;

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  canSend,
  mode,
  onToggleMode,
  compactUi,
  squeezeRatio,
  boxRef,
  measureRef,
  provider,
  permSummary,
  onPermissionChange,
  onOpenSettings,
  modelMenuOpen,
  onOpenModelMenu,
  onCloseModelMenu,
  modelList,
  onChooseModel,
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  permissionLabel,
  onPickAttachment,
  notice,
}: ComposerProps): React.ReactElement {
  const [permMenuOpen, setPermMenuOpen] = React.useState(false);
  const adjustPermission = (category: "read" | "write" | "terminal" | "network", value: "allow" | "confirm" | "deny"): void => {
    if (!permSummary) return;
    onPermissionChange({
      ...permSummary,
      permissions: { ...permSummary.permissions, [category]: value },
    });
  };
  return (
    <div style={styles.composer}>
      <div ref={boxRef} style={styles.composerBox} data-squeeze={squeezeRatio.toFixed(2)}>
        <div ref={measureRef} aria-hidden style={styles.measureRow}>
          <span style={styles.measureChip}><Icon name="bolt" size={12} style={{ marginRight: 4 }} />Build</span>
          <span style={styles.measureChip}>
            <Icon name="check" size={12} style={{ marginRight: 4 }} />
            {permSummary ? permissionLabel(permSummary) : "权限"}
          </span>
          <span style={styles.measureChip}>
            <Icon name="cloud-upload" size={12} style={{ marginRight: 4 }} />
            {provider?.configured ? provider.model : "未配置模型"}
          </span>
          <span style={styles.measureChip}><Icon name="file" size={12} style={{ marginRight: 4 }} />附件</span>
          <span style={styles.measureChip}>停止</span>
          <span style={styles.measureChip}>发送</span>
        </div>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          style={styles.textarea}
          rows={3}
        />
        <div style={styles.chipRow}>
          <button
            type="button"
            className="chip"
            style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}), ...(mode === "build" ? styles.chipActive : {}) }}
            title={`模式：${mode === "build" ? "Build 可执行工具" : "Plan 只读规划"}${compactUi ? "（空间不足，已折叠）" : ""}`}
            aria-label={mode === "build" ? "Build 模式" : "Plan 模式"}
            onClick={onToggleMode}
          >
            <Icon name="bolt" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
            {compactUi ? null : mode === "build" ? "Build" : "Plan"}
          </button>

          <span style={styles.anchor}>
            <button
              type="button"
              className="chip"
              style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
              title={`当前会话权限${compactUi ? "（空间不足，已折叠）" : ""}`}
              aria-label="当前会话权限"
              onClick={() => setPermMenuOpen((open) => !open)}
            >
              <Icon name="check" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
              {compactUi ? null : permSummary ? permissionLabel(permSummary) : "权限"}
            </button>
            {permMenuOpen && permSummary ? (
              <div className="pop-in" style={{ ...styles.popover, ...styles.chipPopover }}>
                <div style={styles.modelMenuHead}>本会话工具权限</div>
                {PERMISSION_CATEGORIES.map((category) => (
                  <div key={category.key} style={styles.permRow}>
                    <span style={styles.permCat}>{category.label}</span>
                    <span style={styles.permSeg}>
                      {(["allow", "confirm", "deny"] as const).map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          className="perm-seg"
                          style={{
                            ...styles.permSegBtn,
                            ...(permSummary.permissions[category.key] === decision ? styles.permSegBtnOn : {}),
                          }}
                          onClick={() => adjustPermission(category.key, decision)}
                        >
                          {decision === "allow" ? "允许" : decision === "confirm" ? "询问" : "拒绝"}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  className="model-item"
                  style={styles.modelMenuFoot}
                  onClick={() => {
                    setPermMenuOpen(false);
                    onOpenSettings("permissions");
                  }}
                >
                  打开完整权限设置…
                </button>
              </div>
            ) : null}
          </span>

          <span style={styles.anchor}>
            <button
              type="button"
              className="chip"
              style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
              title={`选择模型：${provider?.configured ? provider.model : "未配置"}${compactUi ? "（空间不足，已折叠）" : ""}`}
              aria-label="选择模型"
              onClick={onOpenModelMenu}
            >
              <Icon name="cloud-upload" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
              {compactUi ? null : provider?.configured ? provider.model : "未配置模型"}
            </button>
            {modelMenuOpen ? (
              <div className="pop-in" style={{ ...styles.popover, ...styles.chipPopover, width: 300 }}>
                <div style={styles.modelMenuHead}>{provider?.provider ?? "未配置"} · 选择模型</div>
                {modelList === null ? (
                  <div style={styles.modelMenuItem}>加载中…</div>
                ) : (
                  <>
                    {modelList.models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className="model-item"
                        style={{ ...styles.modelMenuItem, ...(model.id === provider?.model ? styles.modelMenuItemActive : {}) }}
                        onClick={() => onChooseModel(model.id)}
                        title={`${model.id}${model.contextWindow ? ` · 上下文 ${Math.round(model.contextWindow / 1000)}K` : ""}${model.thinkingEfforts?.length ? ` · 推理 ${model.thinkingEfforts.join("/")}` : ""}`}
                      >
                        <span style={styles.modelItemName}>
                          {model.id}
                          {model.thinking ? <span style={styles.modelBadge}>推理</span> : null}
                          {model.vision ? <span style={styles.modelBadge}>视觉</span> : null}
                        </span>
                        {model.id === provider?.model ? <Icon name="check" size={12} /> : null}
                      </button>
                    ))}
                    {modelList.error ? <div style={styles.modelMenuErr}>{modelList.error}（可回退到默认模型）</div> : null}
                  </>
                )}
                {effortOptions.length > 0 ? (
                  <div style={styles.effortSection}>
                    <div style={styles.modelMenuHead}>推理等级</div>
                    <div style={styles.effortRow}>
                      {["", ...effortOptions].map((effort) => (
                        <button
                          key={effort || "off"}
                          type="button"
                          className="chip"
                          style={{ ...styles.chip, ...(reasoningEffort === effort ? styles.chipActive : {}) }}
                          onClick={() => onReasoningEffortChange(effort)}
                          title={effort || "关闭推理"}
                        >
                          {effortLabel(effort).replace("推理：", "")}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="model-item"
                  style={styles.modelMenuFoot}
                  onClick={() => {
                    onCloseModelMenu();
                    onOpenSettings("providers");
                  }}
                >
                  管理供应商 / 添加模型…
                </button>
              </div>
            ) : null}
          </span>

          <button
            type="button"
            className="chip"
            style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
            title="添加附件（把文件路径放进消息，Agent 可用工具读取）"
            aria-label="添加附件"
            onClick={onPickAttachment}
          >
            <Icon name="file" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
            {compactUi ? null : "附件"}
          </button>
          <span style={styles.spacer} />
          {busy ? (
            <>
              <Icon name="spinner" size={14} className="spinner" style={styles.spinnerInline} />
              <button
                type="button"
                className="chip"
                style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
                onClick={onStop}
                title={`停止生成${compactUi ? "（空间不足，已折叠）" : ""}`}
                aria-label="停止生成"
              >
                <Icon name="stop" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                {compactUi ? null : "停止"}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="send-btn"
            style={{ ...styles.sendBtn, opacity: canSend ? 1 : 0.45 }}
            onClick={onSend}
            disabled={!canSend}
            title={busy ? "发送转向提示（运行中发送 = 转向，下一轮生效）" : "发送（Enter）"}
          >
            <Icon name={busy ? "forward" : "send"} size={15} />
          </button>
        </div>
      </div>
      <div style={styles.composerFoot}>
        <span style={styles.notice}>
          {notice || (busy ? "生成中…" : mode === "plan" ? "Plan 模式：只读规划，不执行写操作" : "Build 模式：可在权限范围内执行工具")}
        </span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  composer: { flex: "none", borderTop: `1px solid ${BRAND.border}`, padding: "8px 10px 6px", background: BRAND.inkRaised },
  composerBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
  },
  measureRow: { display: "flex", gap: 6, height: 0, overflow: "hidden", opacity: 0, pointerEvents: "none" },
  measureChip: { display: "inline-flex", alignItems: "center", fontSize: 12, whiteSpace: "nowrap" },
  textarea: {
    resize: "none",
    border: "none",
    outline: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 13,
    lineHeight: 1.6,
    fontFamily: "inherit",
    minHeight: 46,
    maxHeight: 160,
  },
  chipRow: { display: "flex", alignItems: "center", gap: 5, flexWrap: "nowrap" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  chipCompact: { width: 24, padding: 0, justifyContent: "center" },
  chipActive: { borderColor: BRAND.ochre, color: BRAND.ochreHover, background: "rgba(200,118,60,0.10)" },
  anchor: { position: "relative", display: "inline-flex" },
  spacer: { flex: 1 },
  spinnerInline: { color: BRAND.ochreHover },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  composerFoot: { display: "flex", gap: 8, marginTop: 4, fontSize: 10.5, color: BRAND.linenFaint, minHeight: 14 },
  notice: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  popover: {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    right: 0,
    zIndex: 30,
    background: BRAND.inkRaised,
    border: `1px solid ${BRAND.borderStrong}`,
    borderRadius: 10,
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
    padding: 8,
    minWidth: 240,
  },
  chipPopover: { width: 260 },
  modelMenuHead: { fontSize: 10.5, color: BRAND.linenFaint, padding: "2px 4px 6px" },
  permRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "3px 4px" },
  permCat: { fontSize: 11, color: BRAND.linenMuted },
  permSeg: { display: "inline-flex", gap: 2 },
  permSegBtn: {
    padding: "1px 6px",
    borderRadius: 6,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenFaint,
    fontSize: 10.5,
    cursor: "pointer",
  },
  permSegBtnOn: { color: BRAND.ochreHover, borderColor: BRAND.ochre, background: "rgba(200,118,60,0.12)" },
  modelMenuItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 6px",
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
  },
  modelMenuItemActive: { color: BRAND.ochreHover, background: "rgba(200,118,60,0.10)" },
  modelItemName: { display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelBadge: {
    fontSize: 9,
    padding: "0 4px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenFaint,
    flexShrink: 0,
  },
  modelMenuErr: { fontSize: 10.5, color: "#f0a35e", padding: "4px 6px" },
  effortSection: { borderTop: `1px solid ${BRAND.border}`, marginTop: 6, paddingTop: 4 },
  effortRow: { display: "flex", gap: 4, flexWrap: "wrap", padding: "0 2px" },
  modelMenuFoot: {
    width: "100%",
    marginTop: 6,
    paddingTop: 6,
    borderTop: `1px solid ${BRAND.border}`,
    justifyContent: "center",
    color: BRAND.linenFaint,
  },
};
