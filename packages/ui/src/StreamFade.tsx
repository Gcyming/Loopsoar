/**
 * 流式吐字渐入（单一产地）：已定型前缀走 Markdown，最后一行尾部逐单元渐入。
 * 切分规则见 streamFade.ts（只对最后一行做渐入，换行处一次性转入 settled）。
 */
import * as React from "react";
import { splitStreamFade, visibleTailUnits } from "./streamFadeSplit.js";

export interface StreamFadeProps {
  text: string;
  Markdown: (props: { text: string; streaming?: boolean }) => React.ReactNode;
}

export default function StreamFadeText({ text, Markdown }: StreamFadeProps): React.ReactElement {
  const maxAtRef = React.useRef(-1);
  const prevTextRef = React.useRef("");
  const fade = splitStreamFade(text);
  if (!text.startsWith(prevTextRef.current)) maxAtRef.current = -1;
  prevTextRef.current = text;

  const units = visibleTailUnits(fade.units).filter((unit) => unit.text);
  const seenAt = maxAtRef.current;
  for (const unit of units) {
    if (unit.at > maxAtRef.current) maxAtRef.current = unit.at;
  }
  return (
    <>
      {fade.settled ? Markdown({ text: fade.settled, streaming: true }) : null}
      {fade.linePrefix}
      {units.map((unit) => (
        <span key={unit.at} className={unit.at > seenAt ? "stream-fade-unit" : undefined}>
          {unit.text}
        </span>
      ))}
    </>
  );
}
