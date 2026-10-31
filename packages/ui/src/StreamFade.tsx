/**
 * 吐字渐入（对齐 slime 的 StreamFadeText 思路）：
 *   · 已定型的正文仍走 Markdown；
 *   · 只有**新出现**的字符单元挂 .stream-fade-unit 做「右→左 + 淡入」；
 *   · 以字符位置 at 作水位，内容回流/净化不改写已播单元 → 不重播、不闪烁。
 * 纯展示组件；Markdown 由调用方注入，避免把渲染器耦合进来。
 */
import * as React from "react";

export interface StreamFadeProps {
  text: string;
  /** 已定型部分渲染器（Markdown）。 */
  Markdown: (props: { text: string; streaming?: boolean }) => React.ReactNode;
  /** 尾部窗口字符数：这一段走渐入。 */
  tailChars?: number;
}

interface Unit {
  at: number;
  text: string;
}

function splitUnits(text: string, tailChars: number): { settled: string; units: Unit[]; linePrefix: string } {
  const tailStart = Math.max(0, text.length - Math.max(1, tailChars));
  const settled = text.slice(0, tailStart);
  const tail = text.slice(tailStart);
  const lineStart = tail.lastIndexOf("\n") + 1;
  const linePrefix = tail.slice(0, lineStart);
  const tailRest = tail.slice(lineStart);
  // CJK 单字、英文按 2 字符成组：既保证断行机会，又避免逐字抖动
  const units: Unit[] = [];
  let index = 0;
  while (index < tailRest.length) {
    const previous = tailRest[index - 1] ?? "";
    const size = /[A-Za-z0-9]/.test(previous) ? 2 : 1;
    const chunk = tailRest.slice(index, index + size);
    units.push({ at: tailStart + lineStart + index, text: chunk });
    index += chunk.length;
  }
  return { settled, units, linePrefix };
}

export default function StreamFadeText({ text, Markdown, tailChars = 36 }: StreamFadeProps): React.ReactElement {
  const maxAtRef = React.useRef(-1);
  const prevTextRef = React.useRef("");
  if (!text.startsWith(prevTextRef.current)) maxAtRef.current = -1;
  prevTextRef.current = text;
  const { settled, units, linePrefix } = splitUnits(text, tailChars);
  const seenAt = maxAtRef.current;
  for (const unit of units) {
    if (unit.at > maxAtRef.current) maxAtRef.current = unit.at;
  }
  return (
    <>
      {settled ? Markdown({ text: settled, streaming: true }) : null}
      {linePrefix}
      {units.map((unit) => (
        <span key={unit.at} className={unit.at > seenAt ? "stream-fade-unit" : undefined}>
          {unit.text}
        </span>
      ))}
    </>
  );
}
