/**
 * DocxRenderer —— .docx/.docm 预览(docx-preview)。
 *
 * 两个关键点:
 *  1. **Shadow DOM 容器**。docx-preview 把文档样式(含 `<style>` 节点)直接写进
 *     传入的容器;写进普通 div 的话,文档里的 `body{…}` / 元素选择器会作用到整个
 *     zai 页面,一个文档就能把 UI 弄花。挂在 shadow root 上,样式天然被隔离在本
 *     组件内 —— 这也是敢保留 `<style>`(而不是清洗掉导致无排版)的前提。
 *  2. **渲染后清洗**。产物经 sanitizeHtml(DOMPurify + URL 白名单)与
 *     hardenStyles(CSS 内的 @import/站外 url)处理,见 sanitizeHtml.ts。
 *
 * docx-preview 自己往容器写 DOM,所以走 ref + useEffect,不返回 React 元素树。
 * 库走动态 import(与 FsTab/FilePreviewBody 的懒加载约定一致,不用 React.lazy
 * —— happy-dom 下 Suspense 不会 resolve)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Spin, Typography } from 'antd'
import { hardenStyles, sanitizeHtml } from './sanitizeHtml.js'

export function DocxRenderer({ data, path }: { data: ArrayBuffer; path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    setError(null)
    setRendering(true)
    // shadow root 复用一个:React 严格模式会跑两遍 effect,重复 attachShadow 会抛。
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadow.innerHTML = ''
    void import('docx-preview')
      .then((m) =>
        m.renderAsync(
          data,
          // renderAsync 只用容器的 innerHTML / appendChild,ShadowRoot 两者都有(handle
          // 的是 DOM 节点本身,与它属于哪个 tree 无关);类型签名写的是 HTMLElement,
          // 这里是安全的窄化。
          shadow as unknown as HTMLElement,
          undefined,
          { inWrapper: true, breakPages: true },
        ),
      )
      .then(() => {
        if (cancelled) return
        shadow.innerHTML = sanitizeHtml(shadow.innerHTML)
        // docx-preview 的默认样式把纸张外框刷成 gray(#808080)当留白底。文档区
        // 恒为白底(见 index.tsx 的 DOC_LIGHT_TOKENS 注释),这里改回白色,页面
        // 之间靠 section 自带的 box-shadow 区分。className 用的就是默认的
        // 'docx',所以 wrapper 选择器固定。
        shadow.querySelector<HTMLElement>('.docx-wrapper')?.style.setProperty('background', '#fff')
        hardenStyles(shadow)
        setRendering(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setRendering(false)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      shadow.innerHTML = ''
    }
  }, [data])

  if (error) {
    return (
      <div data-testid="docx-error" className="p-3">
        <Typography.Paragraph type="danger" className="!mb-0 text-xs">
          解析 docx 失败:{error}
        </Typography.Paragraph>
      </div>
    )
  }
  return (
    <div
      data-testid="document-docx"
      data-path={path}
      className="relative h-full overflow-auto bg-white"
    >
      {/* 内容由 docx-preview 写入 shadow root;这个 div 只是宿主容器。
          text-black:文档段落基本不带显式颜色,文字色从这里继承进 shadow 树
          (shadow DOM 的继承属性取自宿主元素),否则暗色主题下会继承到浅色
          文字、落在白纸上不可见。 */}
      <div ref={hostRef} data-testid="docx-shadow-host" className="min-h-full text-black" />
      {rendering && (
        <div
          data-testid="docx-loading"
          className="absolute inset-0 flex items-center justify-center bg-white/70"
        >
          <Spin />
        </div>
      )}
    </div>
  )
}