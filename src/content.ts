/**
 * Runs on every page, acts only on the open-parcels web UI (<meta name="open-parcels" content="web-ui">).
 * Bridges window.postMessage (page protocol) and the background script.
 */
import browser from "webextension-polyfill";
import { EXTENSION_SOURCE, PROTOCOL_VERSION, parsePageMessage, type ExtensionMessage } from "./lib/protocol.js";
import { isInternalMessage, type InternalMessage } from "./lib/runtime-messages.js";

function isOpenParcelsPage(): boolean {
  const meta = document.querySelector('meta[name="open-parcels"]');
  return meta?.getAttribute("content") === "web-ui";
}

function postToPage(message: ExtensionMessage, targetOrigin: string = window.location.origin): void {
  // targetOrigin is the origin that asked; the browser drops the message if this document differs.
  window.postMessage(message, targetOrigin);
}

function start(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = parsePageMessage(event.data);
    if (message === null) return;
    if (message.type === "hello") {
      postToPage({
        source: EXTENSION_SOURCE,
        type: "hello",
        version: browser.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
      });
      return;
    }
    const internal: InternalMessage = { kind: "page", message };
    void browser.runtime.sendMessage(internal).catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((raw: unknown) => {
    if (isInternalMessage(raw) && raw.kind === "to-page") postToPage(raw.message, raw.targetOrigin);
    return undefined;
  });
}

// The meta tag is in the static index.html, so it exists by document_end; check again once loaded
// in case a page injects it late.
if (isOpenParcelsPage()) {
  start();
} else if (document.readyState !== "complete") {
  window.addEventListener("load", () => {
    if (isOpenParcelsPage()) start();
  }, { once: true });
}
