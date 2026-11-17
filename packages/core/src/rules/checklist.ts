/**
 * 规则 → 自检清单（纯逻辑）。
 *
 * 只收「可执行的约束行」，不重复标题/复选框/问句/已被工具守卫接管的路径禁令。
 * 清单是规则的可勾选投影，不是第二份规则正文。
 */

export interface ChecklistSource {
  id: string;
  scope: "global" | "workspace";
  name: string;
  text: string;
}

export interface Checklist {
  items: string[];
  text: string;
}

const CONSTRAINT = /(必须|只能|禁止|不得|不能|不允许|严禁|不要|应当|应该|务必|一律|never|must|should|always|only|do not|don't|cannot|required)/i;

function isChecklistLine(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 160) return false;
  if (/^#/.test(t) || /^\x60{3}/.test(t) || /^<!--/.test(t)) return false;
  if (/^[-*]\s*\[[ xX]\]/.test(t)) return false;
  if (/[?？]$/.test(t)) return false;
  if (/^(如果|假如|假设|为什么|怎么|如何|是否|能不能|要不要)/.test(t)) return false;
  return CONSTRAINT.test(t);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，,。.!！?？:：;；"'“”‘’()（）\[\]【】]/g, "");
}

export function buildRuleChecklist(sources: ChecklistSource[], exclude: string[] = [], max = 12): Checklist {
  const excluded = new Set(exclude.map(normalize));
  const seen = new Set<string>();
  const items: string[] = [];
  for (const source of sources) {
    for (const raw of source.text.split(/\r?\n/)) {
      const text = raw.replace(/^\s*[-*]\s*/, "").trim();
      if (!isChecklistLine(text)) continue;
      const key = normalize(text);
      if (excluded.has(key) || seen.has(key)) continue;
      seen.add(key);
      items.push(text);
      if (items.length >= max) break;
    }
    if (items.length >= max) break;
  }
  return {
    items,
    text: items.length > 0 ? ["## 提交前自检（Loopsoar）", ...items.map((item) => "- [ ] " + item)].join("\n") : "",
  };
}
