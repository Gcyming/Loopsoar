/**
 * 规则 → 自检清单（纯逻辑）。
 *
 * 只收「可执行的约束行」，不重复标题/复选框/问句/已被工具守卫接管的路径禁令。
 * 清单是规则的可勾选投影，不是第二份规则正文。
 */
import { parseRuleDocument, ruleDocumentKey } from "./document.js";

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

export function buildRuleChecklist(sources: ChecklistSource[], exclude: string[] = [], max = 12): Checklist {
  const excluded = new Set(exclude.map(ruleDocumentKey));
  const seen = new Set<string>();
  const items: string[] = [];
  for (const source of sources) {
    for (const line of parseRuleDocument(source.text, { maxLength: 160 })) {
      if (!CONSTRAINT.test(line.text)) continue;
      if (excluded.has(line.key) || seen.has(line.key)) continue;
      seen.add(line.key);
      items.push(line.text);
      if (items.length >= max) break;
    }
    if (items.length >= max) break;
  }
  return {
    items,
    text: items.length > 0 ? ["## 提交前自检（Loopsoar）", ...items.map((item) => "- [ ] " + item)].join("\n") : "",
  };
}
