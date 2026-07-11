import type { ReactNode } from 'react'

export type LinkSegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; raw: string; href: string }

// 仅匹配 http(s), 避免误把版本号 / 文件路径渲染成链接.
// 字符类排除空白 / < > " ' ), 防止吃到 HTML 边界或 markdown 链接右半边.
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g

// 尾部标点剥离: 句末 "https://x.com." 的 "." 不应圈进 href.
function stripTrailingPunct(href: string): string {
  return href.replace(/[.,;:!?)]+$/, '')
}

export function linkifySegments(text: string): LinkSegment[] {
  if (!text) return [{ kind: 'text', value: text }]
  const segments: LinkSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!
    const raw = m[0]
    const href = stripTrailingPunct(raw)
    if (start > last) {
      segments.push({ kind: 'text', value: text.slice(last, start) })
    }
    segments.push({ kind: 'link', raw, href })
    last = start + raw.length
  }
  if (last < text.length) {
    segments.push({ kind: 'text', value: text.slice(last) })
  }
  return segments
}

export function linkifyText(text: string): ReactNode[] {
  return linkifySegments(text).map((seg, i) => {
    if (seg.kind === 'text') return seg.value
    return (
      <a
        key={i}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#1677ff', textDecoration: 'underline' }}
      >
        {seg.raw}
      </a>
    )
  })
}
