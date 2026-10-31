/**
 * VS Code 风格行级 diff 块（slime 产物卡/工具卡的同一设计）：
 *   · 头部：文件名 + `+N −M` 统计；
 *   · 行首 `+`/`−`/空格 + 整行红绿底色；相同行降透明度；
 *   · 行宽铺满滚动容器（短行不露白、长行横向滚动）—— 用 grid `minmax(min-content, 1fr)`。
 * 纯展示组件。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { diffLines, diffStat } from "./artifacts.js";

export default function DiffBlock({
  oldText,
  newText,
  path,
}: {
  oldText: string;
  newText: string;
  path?: string;
}): React.ReactElement {
  const lines = React.useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const stat = React.useMemo(() => diffStat(lines), [lines]);
  return (
    <div className="think-diff-block">
      <div className="think-diff-header">
        <span className="think-diff-file" title={path}>{path ?? "变更详情"}</span>
        <span className="think-diff-stat">
          <span className="think-diff-add">+{stat.add}</span>
          <span className="think-diff-del">−{stat.del}</span>
        </span>
      </div>
      <div className="think-diff-body diff-rows-fit">
        {lines.map((line, index) => (
          <div key={index} className={`think-diff-row diff-${line.op === "+" ? "add" : line.op === "-" ? "del" : "eq"}`}>
            <span className="think-diff-mark">{line.op === "=" ? " " : line.op}</span>
            <span className="think-diff-text">{line.text || " "}</span>
          </div>
        ))}
      </div>
      <div className="think-diff-foot" style={{ color: BRAND.linenFaint }}>
        共 {lines.length} 行 · +{stat.add} −{stat.del}
      </div>
    </div>
  );
}
