// @vitest-environment happy-dom
//
// ⚠️ 关于 `sanitizeHtml`(DOMPurify 那条路径)为什么**没有**单测:
//
// DOMPurify 3.4.15 在 happy-dom 20 下走的是它的「clobbered node 失败关闭」分支
// ——happy-dom 的元素方法身份检查过不去,于是每个元素都被整段删掉,而且**遍历
// 在第一次删除后就中断**,后面的节点原样留在输出里。实测:
//   sanitize('<p>t</p><p onclick="z">u</p>')     → 't<p onclick="z">u</p>'
//   sanitize('<img src="http://evil/x.png">')    → ''   (真浏览器里应保留 <img>)
//   sanitize('<style>.a{}</style>')              → '.a{}'(真浏览器里应保留 <style>)
// 也就是说在 happy-dom 里跑出来的「通过」既不是真通过,失败也不是真失败,写
// 断言只会制造错误的安全感。仓库里也没有 jsdom(DOMPurify 官方支持的 DOM 实现)。
//
// 所以:sanitizeHtml 的正确性由**真实浏览器**验收(spec §6 的「用带恶意关系的
// docx fixture 验证」),这里只测不依赖 DOMPurify 的两个纯函数 —— stripRemoteCss
// (字符串)与 hardenStyles(普通 DOM querySelectorAll)。

import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { stripRemoteCss, hardenStyles } from '../../../../src/web/src/components/documentPreview/sanitizeHtml.js'

describe('stripRemoteCss', () => {
  it('removes @import and remote url(), keeps data: / relative url()', () => {
    const css = [
      '@import url("http://evil.example/a.css");',
      '.a{background:url(http://evil.example/b.png)}',
      '.b{background:url("//evil.example/c.png")}',
      '.c{src:url(data:font/woff2;base64,AAAA)}',
      '.d{background:url(./local.png)}',
    ].join('\n')
    const out = stripRemoteCss(css)
    expect(out).not.toContain('@import')
    expect(out).not.toContain('evil.example')
    // 内嵌字体/图片的 data: URL 不是出站请求,必须保留 —— 否则 docx 里
    // 内嵌的图像会被清掉。
    expect(out).toContain('url(data:font/woff2;base64,AAAA)')
    expect(out).toContain('url(./local.png)')
  })

  it('keeps blob: url() (docx-preview 用 blob URL 挂内嵌图片)', () => {
    const out = stripRemoteCss('.a{background:url(blob:http://localhost:9201/abc)}')
    expect(out).toContain('blob:http://localhost:9201/abc')
  })
})

describe('hardenStyles', () => {
  it('rewrites every <style> in place', () => {
    const root = document.createElement('div')
    root.innerHTML = '<style>@import url(http://evil.example/a.css); .x{color:red}</style><p>x</p>'
    hardenStyles(root)
    const css = root.querySelector('style')!.textContent ?? ''
    expect(css).not.toContain('evil.example')
    expect(css).toContain('.x{color:red}')
  })

  it('is a no-op when there is nothing to strip', () => {
    const root = document.createElement('div')
    root.innerHTML = '<style>.x{color:red}</style>'
    hardenStyles(root)
    expect(root.querySelector('style')!.textContent).toBe('.x{color:red}')
  })
})