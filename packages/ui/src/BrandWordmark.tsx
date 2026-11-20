import * as React from "react";
import { BRAND } from "./theme.js";

export interface BrandWordmarkProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** 字号；默认与界面正文一致，标题/欢迎页按场景传入。 */
  size?: number;
  weight?: number;
  letterSpacing?: number;
}

/**
 * 官方 wordmark：视觉小写 `loopsoar`，`loop` 用亚麻白、`soar` 用赭石橙。
 *
 * 只用于品牌名本身的展示；正文里的「Loopsoar 支持…」等叙述不拆色，
 * 避免把一句话切成两种颜色。`aria-label` 保留产品名的大小写，屏幕阅读器
 * 仍读作 Loopsoar。
 */
export default function BrandWordmark({
  size = 18,
  weight = 800,
  letterSpacing = 0.4,
  style,
  ...rest
}: BrandWordmarkProps): React.ReactElement {
  return (
    <span
      {...rest}
      aria-label={rest["aria-label"] ?? "Loopsoar"}
      style={{
        ...style,
        display: "inline-flex",
        alignItems: "baseline",
        whiteSpace: "nowrap",
        fontSize: size,
        fontWeight: weight,
        letterSpacing,
        lineHeight: 1.1,
      }}
    >
      <span style={{ color: BRAND.linen }}>loop</span>
      <span style={{ color: BRAND.ochre }}>soar</span>
    </span>
  );
}
