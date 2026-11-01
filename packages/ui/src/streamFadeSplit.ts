/**
 * 流式吐字切分（纯逻辑，单一产地）：
 *   · settled：止于最后一个换行，交给 Markdown 正式渲染；
 *   · linePrefix：最后一行里已定型的前半段（纯文本），与尾巴同一行内流；
 *   · units：尾部逐单元渐入（key=绝对字符位，只播一次）。
 * 关键约束：tail 只取**最后一行**，新字符只追加在行内；换行出现时整行一次性转入
 * settled，切缝落在真实换行上 —— 这样不会出现"末行文字被挤回上一行"的重排（slime A-1080 根因）。
 *
 * 未闭合代码块 / 行内 code 时不渐入，整段落回 Markdown，避免裸露 ** 与 # 等符号。
 */

export const STREAM_FADE_TAIL_MAX = 48;

export interface StreamFadeUnit {
  text: string;
  at: number;
}

export interface StreamFadeSplit {
  settled: string;
  linePrefix: string;
  tail: string;
  units: StreamFadeUnit[];
}

function inUnclosedFence(text: string): boolean {
  return ((text.match(/```/g) ?? []).length % 2) === 1;
}

function inUnclosedInlineCode(line: string): boolean {
  return ((line.match(/`/g) ?? []).length % 2) === 1;
}

/** 把一段文本切成带绝对位置的单元：英文/数字按词，CJK 与符号按字。 */
export function unitize(tail: string, base = 0): StreamFadeUnit[] {
  const pattern = /[A-Za-z0-9_.,;:!?'"()[\]{}<>/\\+\-*=@#$%^&|~`]+|\s+|[\s\S]/g;
  const units: StreamFadeUnit[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tail)) !== null) {
    if (match[0] === "") break;
    units.push({ text: match[0], at: base + match.index });
  }
  return units;
}

/** 切分显示文本：只对最后一行做尾部渐入。 */
export function splitStreamFade(shown: string, maxTail = STREAM_FADE_TAIL_MAX): StreamFadeSplit {
  const noFade: StreamFadeSplit = { settled: shown, linePrefix: "", tail: "", units: [] };
  if (!shown) return { settled: "", linePrefix: "", tail: "", units: [] };
  if (inUnclosedFence(shown)) return noFade;
  const newlineAt = shown.lastIndexOf("\n");
  const line = shown.slice(newlineAt + 1);
  if (inUnclosedInlineCode(line)) return noFade;
  if (!line) return noFade;

  const lineUnits = unitize(line, newlineAt + 1);
  let start = lineUnits.length;
  let accumulated = 0;
  for (let index = lineUnits.length - 1; index >= 0; index -= 1) {
    const length = lineUnits[index].text.length;
    if (accumulated + length > maxTail && start < lineUnits.length) break;
    accumulated += length;
    start = index;
    if (accumulated >= maxTail) break;
  }
  const units = lineUnits.slice(start);
  const tailStart = units.length > 0 ? units[0].at : shown.length;
  const tail = shown.slice(tailStart);
  if (!tail) return noFade;

  const lineStart = newlineAt + 1;
  return {
    settled: shown.slice(0, lineStart),
    linePrefix: shown.slice(lineStart, tailStart),
    tail,
    units,
  };
}

const PURE_MARKER = /^[-+*>#`~_]+$/;
const ORDERED_MARKER = /^\d{1,2}\.$/;
const TABLE_SEP_MARKER = /^[|\-:\s]+$/;

/** 渐入单元的可见文本：抹掉 Markdown 控制符号，避免吐字时露出 `**` / `#`。 */
export function fadeUnitText(raw: string): string {
  if (!raw) return raw;
  if (/^\s+$/.test(raw)) return raw;
  if (PURE_MARKER.test(raw)) return "";
  if (ORDERED_MARKER.test(raw)) return "";
  if (TABLE_SEP_MARKER.test(raw) && /-/.test(raw)) return "";
  return raw
    .replace(/\*\*|~~/g, "")
    .replace(/[*#|`]/g, "")
    .replace(/^[ \t]+(?=\S)/, "");
}

/** 把渐入单元映射为"可见文本"单元（合并多余空白），保证行内不露出控制符。 */
export function visibleTailUnits(units: readonly StreamFadeUnit[]): StreamFadeUnit[] {
  const perUnit = units.map((unit) => fadeUnitText(unit.text));
  const joined = perUnit.join("");
  const visible = joined.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");

  const output: StreamFadeUnit[] = [];
  let visibleIndex = 0;
  for (let index = 0; index < perUnit.length; index += 1) {
    const text = perUnit[index];
    if (!text) {
      output.push({ text: "", at: units[index].at });
      continue;
    }
    if (/^\s+$/.test(text)) {
      if (visible[visibleIndex] === " ") {
        output.push({ text: " ", at: units[index].at });
        visibleIndex += 1;
      } else {
        output.push({ text: "", at: units[index].at });
      }
      continue;
    }
    if (visible.startsWith(text, visibleIndex)) {
      output.push({ text, at: units[index].at });
      visibleIndex += text.length;
    } else {
      const chunk = visible.slice(visibleIndex, visibleIndex + text.length);
      output.push({ text: chunk, at: units[index].at });
      visibleIndex += chunk.length;
    }
  }
  return output;
}
