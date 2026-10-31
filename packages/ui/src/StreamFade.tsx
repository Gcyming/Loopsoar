/**
 * 流式正文渲染（稳定版）：
 *   · 旧实现把文本按"尾部窗口"切成 settled + 逐字单元，随着文本增长，字符会从尾部
 *     搬回 Markdown 前缀，造成行宽重新排版（末行文字被挤回上一行的 slime 老问题）；
 *   · 现在整段交给同一个 Markdown 渲染器，DOM 结构稳定，只保留光标和 CSS 渐入；
 *   · 接口保持不变，调用方无需感知实现变化。
 */
import * as React from "react";

export interface StreamFadeProps {
  text: string;
  Markdown: (props: { text: string; streaming?: boolean }) => React.ReactNode;
}

export default function StreamFadeText({ text, Markdown }: StreamFadeProps): React.ReactElement {
  return (
    <div className="streaming-markdown">
      {Markdown({ text, streaming: true })}
    </div>
  );
}
