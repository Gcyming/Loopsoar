/**
 * 设置页左侧导航：顶部分区搜索 + 按「宽泛 → 具体、相近相邻」排序的分组列表。
 *
 * 搜索为什么不能只筛外层分区：用户找的是「压缩阈值」「图片输入」这种具体开关，
 * 必须能直接定位到控件。索引 = 分区（所有）+ 字段条目（常用高频项，带 anchor）；
 * 选中后切到分区、滚动到 anchor 并短暂高亮。
 */
import * as React from "react";
import { useT } from "./i18n.js";
import { Icon } from "./Icon.js";
import { S } from "./settingsUi.js";
import { SECTIONS, type SectionId } from "./settingsSections.js";

export interface SettingsNavProps {
  section: SectionId;
  onSelect: (id: SectionId) => void;
}

interface SearchEntry {
  section: SectionId;
  /** 控件锚点（见 settingsUi.Field 的 anchor）；缺省只定位到分区。 */
  anchor?: string;
  labelKey: string;
  hintKey?: string;
  /** 用户可能输入的同义词（中英混合）。 */
  keywords: string[];
}

/** 高频字段条目：只列「用户会直接搜开关名」的项，避免维护一份全量表单索引。 */
const FIELD_ENTRIES: SearchEntry[] = [
  { section: "general", anchor: "language", labelKey: "settings.general.language", keywords: ["语言", "language", "中文", "english", "locale"] },
  { section: "general", anchor: "animations", labelKey: "settings.general.animations", hintKey: "settings.general.animationsHint", keywords: ["动画", "animation", "motion", "动效", "过渡"] },
  { section: "general", anchor: "browserOpenLayout", labelKey: "settings.general.browserOpenLayout", keywords: ["窗口布局", "browser layout", "agent window", "小窗", "停靠"] },
  { section: "general", anchor: "adBlock", labelKey: "settings.general.adBlock", hintKey: "settings.general.adBlockHint", keywords: ["广告", "ad", "adblock", "tracking", "拦截"] },
  { section: "general", anchor: "notifications", labelKey: "settings.general.notifications", hintKey: "settings.general.notificationsHint", keywords: ["通知", "notification", "系统通知", "提醒"] },
  { section: "general", anchor: "notificationSound", labelKey: "settings.general.notificationSound", hintKey: "settings.general.notificationSoundHint", keywords: ["提示音", "声音", "sound", "beep", "音效"] },
  { section: "general", anchor: "imageInput", labelKey: "settings.general.imageInput", hintKey: "settings.general.imageInputHint", keywords: ["图片", "image", "vision", "视觉", "多模态", "截图"] },
  { section: "general", anchor: "compressRatio", labelKey: "settings.general.compressRatio", hintKey: "settings.general.compressRatioHint", keywords: ["压缩", "context", "compact", "上下文", "阈值", "token"] },
  { section: "general", anchor: "restoreSession", labelKey: "settings.general.restoreSession", keywords: ["恢复会话", "restore", "session"] },
  { section: "general", anchor: "closeBehavior", labelKey: "settings.general.closeBehavior", hintKey: "settings.general.closeBehaviorHint", keywords: ["托盘", "tray", "关闭窗口", "quit"] },
  { section: "general", anchor: "maxRounds", labelKey: "settings.general.maxRounds", hintKey: "settings.general.maxRoundsHint", keywords: ["轮数", "round", "上限", "防止死循环"] },
];

/** 归一化：小写、去掉空白与常见标点，中英混输入也能命中。 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s·・,，。;；:：!！?？/\\()（）\[\]【】_-]+/g, "");
}

/** 单条相关度：精确 > 前缀 > 包含 > 同义词 > 提示 > 分区名。 */
function scoreOf(entry: SearchEntry, query: string, label: string, hint: string, sectionLabel: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const labelText = normalize(label);
  const hintText = normalize(hint);
  const sectionText = normalize(sectionLabel);
  const keys = entry.keywords.map(normalize);
  if (labelText === q) return 1000;
  if (labelText.startsWith(q)) return 850;
  if (labelText.includes(q)) return 700;
  if (keys.some((key) => key === q)) return 640;
  if (keys.some((key) => key.startsWith(q))) return 560;
  if (keys.some((key) => key.includes(q))) return 470;
  if (hintText.includes(q)) return 320;
  if (sectionText.includes(q)) return 180;
  // 多词查询（"上下文 压缩"）：拆词后所有词都命中才收，分数取最低命中项，避免长词稀释排序。
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const scores = parts.map((part) => scoreOf(entry, part, label, hint, sectionLabel));
    if (scores.every((score) => score > 0)) return Math.min(...scores) + 40;
  }
  return 0;
}

export function SettingsNav({ section, onSelect }: SettingsNavProps): React.JSX.Element {
  const tr = useT();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const results = React.useMemo(() => {
    const q = query.trim();
    if (!q) return [] as { entry: SearchEntry; label: string; hint: string; sectionLabel: string; score: number }[];
    const sectionEntries: SearchEntry[] = SECTIONS.map((item) => ({
      section: item.id,
      labelKey: "settings.nav." + item.id + ".label",
      hintKey: "settings.nav." + item.id + ".hint",
      keywords: [],
    }));
    const seen = new Set<string>();
    const rows = [...FIELD_ENTRIES, ...sectionEntries]
      .map((entry) => {
        const label = tr(entry.labelKey);
        const hint = entry.hintKey ? tr(entry.hintKey) : "";
        const sectionLabel = tr("settings.nav." + entry.section + ".label");
        return {
          entry,
          label,
          hint,
          sectionLabel,
          score: scoreOf(entry, q, label, hint, sectionLabel),
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.label.length - b.label.length)
      .filter((row) => {
        // 同一控件/分区只出现一次（字段条目优先，分区条目兜底）。
        const key = row.entry.anchor ? "a:" + row.entry.anchor : "s:" + row.entry.section;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return rows.slice(0, 8);
  }, [query, tr]);

  React.useEffect(() => setActive(0), [query]);

  const choose = (row: { entry: SearchEntry }): void => {
    onSelect(row.entry.section);
    setQuery("");
    setActive(0);
    const anchor = row.entry.anchor;
    if (!anchor) return;
    // 等分区内容挂载后再滚动；高亮 1.4s，保证「定位到了」这件事可见。
    window.setTimeout(() => {
      const element = document.getElementById("settings-anchor-" + anchor);
      if (!element) return;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add("settings-anchor-flash");
      window.setTimeout(() => element.classList.remove("settings-anchor-flash"), 1500);
    }, 90);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active] ?? results[0]);
    }
  };

  return (
    <nav style={S.nav}>
      <div style={S.searchWrap}>
        <div style={S.searchBox}>
          <Icon name="search" size={13} style={{ flex: "none", color: "var(--ls-text-faint)" }} />
          <input
            ref={inputRef}
            className="settings-search-input"
            style={S.searchInput}
            value={query}
            placeholder={tr("settings.search.placeholder")}
            aria-label={tr("settings.search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="icon-btn"
              style={S.searchClear}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              title={tr("settings.search.clear")}
            >
              <Icon name="close" size={11} />
            </button>
          ) : null}
        </div>
        {query.trim() ? (
          <div style={S.searchResults} className="settings-search-results" role="listbox" aria-label={tr("settings.search.placeholder")}>
            {results.length === 0 ? (
              <div style={S.searchEmpty}>{tr("settings.search.empty")}</div>
            ) : (
              results.map((row, index) => (
                <button
                  key={(row.entry.anchor ?? "s-") + row.entry.section + "-" + index}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  style={{ ...S.searchItem, ...(index === active ? S.searchItemActive : {}) }}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                >
                  <Icon name={SECTIONS.find((item) => item.id === row.entry.section)?.icon ?? "settings"} size={13} style={{ flex: "none", marginTop: 1 }} />
                  <span style={S.searchText}>
                    <span style={S.searchLabel}>{row.label}</span>
                    <span style={S.searchCrumb}>
                      {row.sectionLabel}
                      {row.hint ? " · " + row.hint : ""}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <div className="settings-nav-list" style={S.navList}>
        {SECTIONS.map((item, index) => (
          <React.Fragment key={item.id}>
            {index === 0 || item.group !== SECTIONS[index - 1].group ? (
              <div style={S.navGroup}>{tr("settings.nav.group." + item.group)}</div>
            ) : null}
            <button
              type="button"
              className={"settings-nav-item" + (section === item.id ? " is-active" : "")}
              style={{ ...S.navItem, ...(section === item.id ? S.navItemActive : {}) }}
              onClick={() => onSelect(item.id)}
            >
              <Icon name={item.icon} size={15} style={{ marginTop: 2, flex: "none" }} />
              <span style={S.navText}>
                <span style={S.navLabel}>{tr("settings.nav." + item.id + ".label")}</span>
                <span style={S.navHint}>{tr("settings.nav." + item.id + ".hint")}</span>
              </span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </nav>
  );
}
