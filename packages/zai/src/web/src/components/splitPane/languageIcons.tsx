/**
 * 内联 SVG 图标库 — FsTab 文件树专属.
 *
 * 不用 antd / Material Icon Theme / react-icons —— 那些要么没有
 * 专属形状(.ts / .js / .css 都被 antd 折叠成同一个 FileOutlined),
 * 要么 +500KB 体积.
 *
 * 这里每种语言 / 文件类型是一个独立的 SVG,设计风格: VSCode
 * Material Icon Theme "色块 + 字母 / 形状" 模型.16×16 viewBox,每个
 * 图标包含一个色块背景 + 字符或图形,一眼区分. 颜色跟 index.css
 * 里 [data-file-ext] 的色板对齐,这样即便 antd icon 挂了 fallback,
 * 视觉契约也保持一致.
 *
 * 用法: 直接 `<TsIcon />` 或经 fileIcon.tsx 的 pickFileIcon() 出口.
 */
import type { CSSProperties, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
const def = (size = 14): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true as const,
  focusable: false,
});

/* ── 基础"色块 + 字符"形状 ────────────────────────────────
   在 14×14 实际渲染时仍用 16×16 viewBox,所以这里 font-size 反而要
   大一点(7-7.5),这样缩放后视觉清晰. */
const S = (size: number): CSSProperties => ({
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontWeight: 800,
  fontSize: size >= 16 ? 7 : size >= 14 ? 7.5 : size >= 12 ? 7 : 6,
  fill: '#ffffff',
});

export function TsIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#3178c6" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>TS</text>
    </svg>
  );
}

export function TsxIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#3178c6" />
      <text x="5.7" y="10.5" textAnchor="middle" style={S(size)}>TS</text>
      <text x="11.3" y="10.5" textAnchor="middle" style={S(size)}>X</text>
    </svg>
  );
}

export function JsIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#f7df1e" />
      <text x="8" y="10.5" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>JS</text>
    </svg>
  );
}

export function JsxIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#f7df1e" />
      <text x="5.7" y="10.5" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>JS</text>
      <text x="11.3" y="10.5" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>X</text>
    </svg>
  );
}

const LB = '\u007B'; // '{' — 拆字符常量避免 JSX text 把相邻 '{' 解析成表达式/正则
const RB = '\u007D'; // '}'

export function JsonIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#fbbf24" />
      <text x="5.5" y="11" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>{LB}</text>
      <text x="11" y="11" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>{RB}</text>
    </svg>
  );
}

export function JsonlIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#fbbf24" />
      <text x="4.2" y="11" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>{LB}</text>
      <text x="7.6" y="11" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>{RB}</text>
      <text x="12.5" y="11" textAnchor="middle" style={{ ...S(size), fill: '#1f1f1f' }}>—</text>
    </svg>
  );
}

export function HtmlIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#e34c26" />
      <path d="M4 6 L8 5.2 L12 6 L11 11 L8 12.4 L5 11 Z" fill="#ffffff" />
      <path d="M8 7 V11.1 M6.4 8.2 H9.6" stroke="#e34c26" strokeWidth="0.6" />
    </svg>
  );
}

export function CssIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#1572b6" />
      <path d="M5 5 L6.2 11 L8 11.6 L9.8 11 L11 5 Z" fill="#ffffff" />
      <path d="M7.4 7 H10.6 M7.6 8.6 H10.4 M8 10 L7.4 9.4 H9.2 L8.6 10.2" stroke="#1572b6" strokeWidth="0.5" />
    </svg>
  );
}

export function ScssIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#c69" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>S</text>
    </svg>
  );
}

export function VueIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#42b883" />
      <path d="M3 5 L6 5 L8 9 L10 5 L13 5 L8 14 Z" fill="#35495e" />
    </svg>
  );
}

export function SvelteIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#ff3e00" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>S</text>
    </svg>
  );
}

export function MdIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#6366f1" />
      <path d="M3.5 8 Q8 4 12.5 8 Q8 12 3.5 8 Z" fill="none" stroke="#ffffff" strokeWidth="1.4" />
      <line x1="8" y1="8" x2="8" y2="11" stroke="#6366f1" strokeWidth="1.1" />
      <line x1="8" y1="11" x2="8" y2="13" stroke="#6366f1" strokeWidth="1.1" />
    </svg>
  );
}

export function PyIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="8" height="16" rx="2" fill="#3776ab" />
      <rect x="8" width="8" height="16" rx="2" fill="#ffd43b" />
      <text x="4" y="10" textAnchor="middle" style={S(size)}>P</text>
      <text x="12" y="10" textAnchor="middle" style={S(size)}>y</text>
    </svg>
  );
}

export function GoIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#00add8" />
      <text x="5" y="11" textAnchor="middle" style={S(size)}>G</text>
      <text x="11" y="11" textAnchor="middle" style={S(size)}>o</text>
    </svg>
  );
}

export function RsIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#000000" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>Rs</text>
    </svg>
  );
}

export function JavaIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#ed8b00" />
      <path d="M8 13 Q5 11 5 9 Q5 7.5 7 7.5 Q8 7.5 8.5 8.5" fill="none" stroke="#ffffff" strokeWidth="1.1" />
      <path d="M9 6 Q11 5 11 6.5 Q11 7.8 9 8" fill="none" stroke="#ffffff" strokeWidth="1.1" />
    </svg>
  );
}

export function KtIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#7f52ff" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>Kt</text>
    </svg>
  );
}

export function RbIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#cc342d" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>Rb</text>
    </svg>
  );
}

export function PhpIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#777bb4" />
      {/* 紫色块 + 白色 ellipsis 提示 PHP "lab" 风格 */}
      <ellipse cx="8" cy="8" rx="4" ry="3" fill="#ffffff" />
      <circle cx="8" cy="8" r="1.3" fill="#777bb4" />
    </svg>
  );
}

export function CIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#a8b9cc" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>C</text>
    </svg>
  );
}

export function CppIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#f34b7d" />
      <text x="6" y="10.5" textAnchor="middle" style={S(size)}>C</text>
      <text x="11.5" y="10.5" textAnchor="middle" style={S(size)}>+</text>
      <text x="13.5" y="9.5" textAnchor="middle" style={{ ...S(size), fontSize: 5 }}>+</text>
    </svg>
  );
}

export function ShIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#4d4d4d" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>$</text>
    </svg>
  );
}

export function YamlIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#cb171e" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>Y</text>
    </svg>
  );
}

export function TomlIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#9c4221" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>T</text>
    </svg>
  );
}

export function LockIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#525252" />
      <path d="M5.5 7 V5.5 Q5.5 3.5 8 3.5 Q10.5 3.5 10.5 5.5 V7" fill="none" stroke="#ffffff" strokeWidth="1.1" />
      <rect x="4.5" y="7" width="7" height="6" rx="1" fill="#ffffff" />
      <circle cx="8" cy="9.5" r="0.8" fill="#525252" />
    </svg>
  );
}

export function TexIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#008080" />
      <text x="5" y="11" textAnchor="middle" style={S(size)}>T</text>
      <text x="11" y="11" textAnchor="middle" style={S(size)}>E</text>
    </svg>
  );
}

export function ImageIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#a78bfa" />
      <rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="#ffffff" strokeWidth="1" />
      <circle cx="5.5" cy="6.5" r="1.1" fill="#ffffff" />
      <path d="M3 12 L6 9 L9 11 L13 7 V13 H3 Z" fill="#ffffff" opacity="0.9" />
    </svg>
  );
}

export function PdfIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#ef4444" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>PDF</text>
    </svg>
  );
}

export function DocIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#2b579a" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>W</text>
    </svg>
  );
}

export function XlsIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#21a366" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>X</text>
    </svg>
  );
}

export function PptIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#d24726" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>P</text>
    </svg>
  );
}

export function ArchiveIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#f59e0b" />
      <rect x="2" y="4" width="12" height="9" rx="1.5" fill="none" stroke="#ffffff" strokeWidth="1.1" />
      <rect x="3.5" y="6.5" width="9" height="2" fill="#ffffff" />
      <rect x="3.5" y="9.5" width="9" height="2" fill="#ffffff" />
    </svg>
  );
}

/* ── 特殊文件名 / 工具图标 ───────────────────────────────── */

export function TextIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#94a3b8" />
      <line x1="4.5" y1="6" x2="11.5" y2="6" stroke="#ffffff" strokeWidth="0.9" />
      <line x1="4.5" y1="8.5" x2="11.5" y2="8.5" stroke="#ffffff" strokeWidth="0.9" />
      <line x1="4.5" y1="11" x2="9.5" y2="11" stroke="#ffffff" strokeWidth="0.9" />
    </svg>
  );
}

export function LogIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#94a3b8" />
      <line x1="4.5" y1="5" x2="11.5" y2="5" stroke="#ffffff" strokeWidth="0.7" />
      <line x1="4.5" y1="7.2" x2="11.5" y2="7.2" stroke="#ffffff" strokeWidth="0.7" />
      <line x1="4.5" y1="9.4" x2="9.5" y2="9.4" stroke="#ffffff" strokeWidth="0.7" />
      <line x1="4.5" y1="11.6" x2="11" y2="11.6" stroke="#ffffff" strokeWidth="0.7" />
    </svg>
  );
}

export function NpmrcIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#cb3837" />
      {/* npm diamond */}
      <path d="M8 2.5 L13.5 8 L8 13.5 L2.5 8 Z" fill="#ffffff" />
      <rect x="8" y="8" width="5.5" height="5.5" transform="rotate(45 8 8)" fill="#cb3837" />
    </svg>
  );
}

export function GitIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#f05033" />
      {/* git fork shape */}
      <path d="M5 4 V8 M11 4 V8 M5 12 V8 M5 8 Q11 8 11 12" stroke="#ffffff" strokeWidth="1.2" fill="none" />
      <circle cx="5" cy="3.5" r="1.3" fill="#ffffff" />
      <circle cx="11" cy="3.5" r="1.3" fill="#ffffff" />
      <circle cx="5" cy="12.5" r="1.3" fill="#ffffff" />
    </svg>
  );
}

export function EnvIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#ecd53f" />
      <circle cx="5.5" cy="8" r="1.8" fill="none" stroke="#000000" strokeWidth="0.9" />
      <path d="M6.8 6.5 L11 6 L9 9 L11.5 9.5 L8 13 L9 9.5 L7 9.5 Z" fill="#000000" />
    </svg>
  );
}

export function DockerIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#0db7ed" />
      <path d="M3 9 H12 V11 H3 Z" fill="#ffffff" />
      <rect x="4.5" y="7" width="2" height="1.5" fill="#ffffff" />
      <rect x="7" y="7" width="2" height="1.5" fill="#ffffff" />
      <rect x="9.5" y="7" width="2" height="1.5" fill="#ffffff" />
      <rect x="4.5" y="5" width="2" height="1.5" fill="#ffffff" />
      <rect x="7" y="5" width="2" height="1.5" fill="#ffffff" />
    </svg>
  );
}

export function MakefileIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#427819" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>M</text>
    </svg>
  );
}

export function LicenseIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="#525252" />
      <text x="8" y="10.5" textAnchor="middle" style={S(size)}>©</text>
    </svg>
  );
}

export function OtherIcon(p: IconProps = {}) {
  const { size = 14, ...rest } = p;
  return (
    <svg {...def(size)} {...rest}>
      <rect width="16" height="16" rx="3" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.4)" />
      <line x1="5" y1="6" x2="11" y2="6" stroke="rgba(255,255,255,0.7)" strokeWidth="0.7" />
      <line x1="5" y1="8.5" x2="11" y2="8.5" stroke="rgba(255,255,255,0.7)" strokeWidth="0.7" />
      <line x1="5" y1="11" x2="9" y2="11" stroke="rgba(255,255,255,0.7)" strokeWidth="0.7" />
    </svg>
  );
}

/* ── 目录(opencode-ish: 立体书本) ─────────────────────── */

export function DirIconSvg({ open, size = 14, ...rest }: { open?: boolean; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...def(size)} {...rest}>
      <path
        d="M2.5 4.5 Q2.5 3.5 3.5 3.5 H6.5 L8 5 H12.5 Q13.5 5 13.5 6 V12 Q13.5 13 12.5 13 H3.5 Q2.5 13 2.5 12 Z"
        fill={open ? '#fbbf24' : '#facc15'}
      />
      <path d="M2.5 4.5 H12.5 Q13.5 5 13.5 6 V7 H2.5 Z" fill="rgba(0,0,0,0.18)" />
      {open && <path d="M2.5 4.5 H13.5 V7 H2.5 Z" fill="rgba(255,255,255,0.15)" />}
    </svg>
  );
}

export function DirOpenIconSvg(p: { size?: number } & SVGProps<SVGSVGElement> = {}) {
  const { size = 14, ...rest } = p;
  return <DirIconSvg open size={size} {...rest} />;
}
