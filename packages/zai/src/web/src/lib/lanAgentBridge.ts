// lib/lanAgentBridge.ts — register window.lanAgentAttachImage(s) at module
// load time so the bridge is available the moment the page's JS executes,
// independent of React useEffect timing, StrictMode double-invocation, or
// bundler side-effect analysis. lan-agent's WebViewScreen.kt probes
// `typeof window.lanAgentAttachImages === 'function'` before invoking it;
// as long as this module has been imported somewhere in the entry chunk,
// the global is set.
//
// Imported (side-effect) from main.tsx so the registration runs before
// any component mounts.
//
// ⚠️ 2026-10-11:这个 side-effect import 之前**实际上不存在** —— main.tsx 只
// import 了 App 与 index.css,全仓没有任何地方引用本模块,所以
// window.lanAgentAttachImages 运行时从未注册,lan-agent 的图片注入一直静默
// 走 WebView 的降级路径(onShowFileChooser → File 转换,在部分 ROM 上不可靠)。
// 本次补上入口导入后该桥才真正生效。

import { useAgentStore } from "../store/useAgentStore";
import { readImageAsBase64 } from "./imageReader";

type AttachItem = {
  dataUrl: string;
  filename: string;
  mime: string;
};

declare global {
  interface Window {
    lanAgentAttachImage?: (
      dataUrl: string,
      filename: string,
      mime: string,
    ) => Promise<void>;
    lanAgentAttachImages?: (items: AttachItem[]) => Promise<void>;
    /**
     * 回到 lan-agent 原生的 Agent 对话(底栏「任务」栏)。
     *
     * 页面自己不认识原生导航,只能通过这里转发到 lan-agent 的
     * `@JavascriptInterface` 桥(JS 名 `AndroidWebview`,见
     * lan-agent 的 ui/WebViewScreen.kt)。调用方据此判断要不要渲染按钮:
     * 探不到桥 = 当前不是 lan-agent(或 App 版本还没带这个桥),返回
     * false 而不是抛错,让 UI 自行降级。
     */
    lanAgentGoToAgent?: () => boolean;
    /**
     * lan-agent 通过 addJavascriptInterface 注入的对象。本文件只在
     * lanAgentGoToAgent 内部探测它,组件层不该直接摸。
     */
    AndroidWebview?: { goToAgent?: () => boolean };
  }
}

if (typeof window !== "undefined") {
  // Internal helper: wrap one base64 dataUrl in a File and add to the
  // current conversation's attachments via the store action.
  const attachOne = async (
    dataUrl: string,
    filename: string,
    mime: string,
  ): Promise<void> => {
    // readImageAsBase64 validates the mime is one zai accepts; if it
    // throws the attachment will land in 'error' state and the input
    // UI shows an error chip.
    const r = await fetch(dataUrl);
    const blob = await r.blob();
    const file = new File([blob], filename, { type: mime });
    await readImageAsBase64(file);
    // Push straight into the store: the store's addAttachment is what
    // MobileAgent's AgentInputBox wires up its input box to consume.
    useAgentStore.getState().addAttachment({
      localId:
        (globalThis.crypto && "randomUUID" in globalThis.crypto
          ? globalThis.crypto.randomUUID()
          : Math.random().toString(36).slice(2)) + "-lan",
      mime: file.type,
      size: file.size,
      filename: file.name || "image",
      thumbnailUrl: URL.createObjectURL(file),
      base64DataUrl: "",
      status: "ready",
    });
  };

  window.lanAgentAttachImage = attachOne;
  window.lanAgentAttachImages = async (items: AttachItem[]) => {
    // Serial, not Promise.all: useAgentStore.addAttachment mutates the
    // attachments array; concurrent calls would race on the same state.
    for (const item of items) {
      try {
        await attachOne(item.dataUrl, item.filename, item.mime);
      } catch (e) {
        console.error("[lanAgent] attachOne failed", item.filename, e);
      }
    }
  };

  // 页面 → 原生的向下转发。lan-agent 的原生 Agent 对话在底栏「任务」栏,
  // 页内无从切换 tab,只能让它那边接。探不到桥返回 false 让调用方降级
  // (非 lan-agent 环境 / App 版本早于该桥),不抛错。
  window.lanAgentGoToAgent = () => {
    const bridge = window.AndroidWebview;
    if (!bridge || typeof bridge.goToAgent !== "function") return false;
    return bridge.goToAgent();
  };

  // Marker so lan-agent can probe "is this page lan-agent-aware" without
  // also having to detect function existence.
  (window as unknown as { __lanAgentBridgeVersion?: number }).__lanAgentBridgeVersion = 1;
}

export {};
