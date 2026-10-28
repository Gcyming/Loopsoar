import React from "react";

/**
 * 图标组件：SVG 作为 CSS mask（`--icon` 变量），颜色跟随 currentColor。
 * 资产来自本地图标库（ui/public/icons，随构建分发）；主题/禁用态自动换色。
 */
export function Icon({
  name,
  size = 16,
  style,
  className,
}: {
  name: string;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}): React.JSX.Element {
  const vars = { "--icon": `url(./icons/${name}.svg)` } as unknown as React.CSSProperties;
  return (
    <span
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      style={{ width: size, height: size, ...vars, ...style }}
    />
  );
}
