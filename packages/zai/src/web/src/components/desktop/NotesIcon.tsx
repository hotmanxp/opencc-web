// macOS Notes.app 风格叠层便签图标:后层绿色 + 中层粉色 + 前层黄色便签(折角+文本线)。
// 用纯 SVG 重绘,无外部资源依赖,跨平台一致。
// size 参数控制外框,默认 18 与其他 antd DockButton 图标尺寸对齐。
interface NotesIconProps {
  size?: number;
}

export default function NotesIcon({ size = 18 }: NotesIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={{ display: 'block' }}
    >
      {/* 后层绿色便签(轻微左偏 + 上偏) */}
      <rect x="7" y="2.5" width="12" height="15" rx="1.6" fill="#a8e6a1" />
      {/* 中层粉色便签(中间位置) */}
      <rect x="4.5" y="4.5" width="12" height="15" rx="1.6" fill="#ff9e9e" />
      {/* 前层黄色便签:折角 = 右上角斜切 */}
      <path
        d="M2.5 7 H15 L17.5 9.5 V21 H2.5 Z"
        fill="#ffd75e"
        stroke="rgba(0,0,0,.12)"
        strokeWidth="0.3"
        strokeLinejoin="round"
      />
      {/* 折角高亮(浅黄三角) */}
      <path d="M15 7 L17.5 9.5 H15 Z" fill="rgba(255,255,255,.35)" />
      {/* 文本线(三条横线模拟手写) */}
      <line x1="4.8" y1="12" x2="14.2" y2="12" stroke="rgba(0,0,0,.4)" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="4.8" y1="14.5" x2="13" y2="14.5" stroke="rgba(0,0,0,.4)" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="4.8" y1="17" x2="11.5" y2="17" stroke="rgba(0,0,0,.4)" strokeWidth="0.7" strokeLinecap="round" />
    </svg>
  );
}
