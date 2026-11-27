/**
 * Registered only on enabled open-parcels origins (lib/registration.ts), and acts only on the web
 * UI itself (<meta name="open-parcels" content="web-ui">). Bridges window.postMessage (page
 * protocol) and the background script.
 */
import browser from "webextension-polyfill";
import { EXTENSION_SOURCE, PROTOCOL_VERSION, isOwnWindowMessage, parsePageMessage, type ExtensionMessage } from "./lib/protocol.js";
import { log } from "./lib/log.js";
import { parseInternalMessage, type InternalMessage } from "./lib/runtime-messages.js";

function isOpenParcelsPage(): boolean {
  const meta = document.querySelector('meta[name="open-parcels"]');
  return meta?.getAttribute("content") === "web-ui";
}

/** targetOrigin is the origin that asked; the browser drops the message if this document differs. */
function postToPage(message: ExtensionMessage, targetOrigin: string): void {
  window.postMessage(message, targetOrigin);
}

function onWindowMessage(event: MessageEvent<unknown>): void {
  if (!isOwnWindowMessage(event, window)) return;
  const message = parsePageMessage(event.data);
  if (message === null) return;
  if (message.type === "hello") {
    postToPage(
      { source: EXTENSION_SOURCE, type: "hello", version: browser.runtime.getManifest().version, protocol: PROTOCOL_VERSION, cookieCapture: true },
      window.location.origin,
    );
    return;
  }
  const internal: InternalMessage = { kind: "page", message };
  browser.runtime.sendMessage(internal).catch((error: unknown) => {
    log.warn("could not reach the extension background", error);
  });
}

function onRuntimeMessage(raw: unknown): undefined {
  const message = parseInternalMessage(raw);
  if (message?.kind === "to-page") postToPage(message.message, message.targetOrigin);
  return undefined;
}

function start(): void {
  window.addEventListener("message", onWindowMessage);
  browser.runtime.onMessage.addListener(onRuntimeMessage);
}

// The meta tag is in the static index.html, so it exists by document_end; check again once loaded
// in case a page injects it late.
if (isOpenParcelsPage()) {
  start();
} else if (document.readyState !== "complete") {
  window.addEventListener(
    "load",
    () => {
      if (isOpenParcelsPage()) start();
    },
    { once: true },
  );
}
