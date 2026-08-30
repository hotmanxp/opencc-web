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

  // Marker so lan-agent can probe "is this page lan-agent-aware" without
  // also having to detect function existence.
  (window as unknown as { __lanAgentBridgeVersion?: number }).__lanAgentBridgeVersion = 1;
}

export {};
