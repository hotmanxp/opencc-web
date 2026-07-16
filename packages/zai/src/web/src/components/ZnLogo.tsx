import type { CSSProperties } from 'react';

type ZnLogoProps = {
  size?: number;
  style?: CSSProperties;
  className?: string;
};

// 知鸟 LOGO · 橙色像素鸟 · 64x64 viewBox
// 主色 #F26B2A / 阴影 #C9521F / 黑瞳 / 白眼底
// Inline SVG,避免 vite 资源解析,直接组件引用.
export default function ZnLogo({ size = 32, style, className }: ZnLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      style={{ imageRendering: 'pixelated', display: 'block', ...style }}
      aria-label="知鸟"
    >
      <g fill="#F26B2A">
        <rect x="28" y="14" width="4" height="4"/>
        <rect x="24" y="18" width="12" height="4"/>
        <rect x="20" y="22" width="16" height="4"/>
        <rect x="16" y="26" width="4" height="4"/>
        <rect x="20" y="26" width="16" height="4"/>
        <rect x="20" y="30" width="20" height="4"/>
        <rect x="16" y="34" width="28" height="4"/>
        <rect x="16" y="38" width="28" height="4"/>
        <rect x="20" y="42" width="24" height="4"/>
        <rect x="44" y="34" width="4" height="4"/>
        <rect x="48" y="30" width="4" height="4"/>
        <rect x="52" y="26" width="4" height="4"/>
        <rect x="56" y="22" width="4" height="4"/>
        <rect x="22" y="46" width="4" height="4"/>
        <rect x="34" y="46" width="4" height="4"/>
        <rect x="20" y="50" width="8" height="4"/>
        <rect x="32" y="50" width="8" height="4"/>
      </g>
      <g fill="#ffffff">
        <rect x="24" y="22" width="4" height="4"/>
      </g>
      <g fill="#0f0f10">
        <rect x="26" y="22" width="2" height="2"/>
      </g>
      <g fill="#C9521F">
        <rect x="20" y="42" width="24" height="4"/>
        <rect x="20" y="34" width="4" height="4"/>
      </g>
    </svg>
  );
}