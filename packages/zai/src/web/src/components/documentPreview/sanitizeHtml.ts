/**
 * docx 渲染产物的清洗(安全边界,2026-09-21)。
 *
 * docx-preview 会把 OOXML 里的关系**原样**翻成 HTML:文档内嵌的 `<script>`、
 * `on*` 属性、指向站外的 `<img src="http://…">` / `<a href="http://…">` 都会
 * 落进 DOM。预览是纯离线渲染,既不能执行文档里的脚本,也不能因为「打开了一个
 * 文档」就向站外发出请求。两道清洗:
 *
 *   1. `sanitizeHtml` —— DOMPurify 默认策略(script/iframe/on* 丢弃;`<link>`
 *      本就不在白名单),再额外剥掉所有非 `data:` / `blob:` 的 URL 属性。
 *   2. `hardenStyles` —— DOMPurify 不解析 `<style>` 的**文本内容**,而
 *      `@import url(http://…)` 与 `url(http://…)` 一样会发请求,所以单独扫一遍。
 *
 * `<style>` 本身**保留**:丢掉它 docx 会退化成无排版纯文本。作用域问题由
 * 调用方(DocxRenderer)解决 —— 渲染产物写进 Shadow DOM,样式不会外泄到宿主页面。
 */
import DOMPurify from 'dompurify'

/** 任何带 scheme 或协议相对的 URL(即"可能是站外")。 */
const REMOTE_URL_RE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i
/** 白名单内的 scheme:内嵌数据与本地 blob,都不会出网。 */
const LOCAL_URL_RE = /^\s*(?:data|blob):/i
/** 会触发子资源加载 / 跳转的属性。 */
const URL_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'background'] as const

const FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta']

let hookInstalled = false

function installHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (typeof el.getAttribute !== 'function') return
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr)
      if (v == null || v === '') continue
      if (REMOTE_URL_RE.test(v) && !LOCAL_URL_RE.test(v)) el.removeAttribute(attr)
    }
    // srcset 是逗号分隔的候选列表,逐项判定;任一项是站外就整条丢掉
    // (docx-preview 本身不产出 srcset,这里只是防止把手写 HTML 透传进来)。
    const srcset = el.getAttribute('srcset')
    if (srcset && srcset.split(',').some((c) => {
      const u = c.trim().split(/\s+/)[0] ?? ''
      return REMOTE_URL_RE.test(u) && !LOCAL_URL_RE.test(u)
    })) {
      el.removeAttribute('srcset')
    }
  })
}

/** 清洗一段 HTML 字符串(DOMPurify 默认白名单 + URL 白名单)。 */
export function sanitizeHtml(html: string): string {
  installHook()
  return DOMPurify.sanitize(html, { FORBID_TAGS, KEEP_CONTENT: true })
}

/**
 * CSS 里的 `@import …` 与 `url(http://…)` 会发起网络请求 —— 整体删掉
 * `@import`,站外 `url()` 置空;`data:` / `blob:` 的 `url()` 保留(内嵌图片/字体)。
 */
export function stripRemoteCss(css: string): string {
  // @import 规则(到分号或换行为止)。
  let out = css.replace(/@import[^;\n]*;?/gi, '')
  // url(...) —— 只放行 data: / blob: / 相对路径。
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q, target: string) => {
    if (target === '') return whole
    if (REMOTE_URL_RE.test(target) && !LOCAL_URL_RE.test(target)) return 'url("")'
    return whole
  })
  return out
}

/** 就地硬化 root 内所有 `<style>` 的文本内容。 */
export function hardenStyles(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('style'))) {
    const css = el.textContent ?? ''
    const clean = stripRemoteCss(css)
    if (clean !== css) el.textContent = clean
  }
}