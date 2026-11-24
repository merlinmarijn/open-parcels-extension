/**
 * Background (Chromium service worker / Firefox event page): wires browser events to the
 * CaptureManager (lib/captures.ts), which holds all capture logic. Listeners are registered
 * synchronously at the top level so a restarted worker receives the event that woke it.
 */
import browser, { type Runtime, type Tabs, type WebRequest } from "webextension-polyfill";
import { CaptureManager, type Opened, type PageTarget } from "./lib/captures.js";
import { ConsentStore } from "./lib/consent.js";
import { log } from "./lib/log.js";
import { OriginStore, normaliseOrigin, originPattern, originTrust } from "./lib/origins.js";
import { RESUME_DELAY_MS, type ExtensionMessage, type PageMessage } from "./lib/protocol.js";
import { syncBridge } from "./lib/registration.js";
import { isResumeTrigger } from "./lib/resume.js";
import { parseInternalMessage, type InternalMessage } from "./lib/runtime-messages.js";

const origins = new OriginStore(browser.storage.local);
const consent = new ConsentStore(browser.storage.local, (pattern) => browser.permissions.contains({ origins: [pattern] }));

async function openWindow(url: string, width: number, height: number): Promise<Opened> {
  try {
    const win = await browser.windows.create({ url, type: "popup", width, height });
    return { tabId: win.tabs?.[0]?.id ?? null, windowId: win.id ?? null };
  } catch (error) {
    // Some browsers/platforms have no popup windows; a normal tab works too.
    log.warn("popup window unavailable, using a tab", error);
    const tab = await browser.tabs.create({ url, active: true });
    return { tabId: tab.id ?? null, windowId: null };
  }
}

async function post(page: PageTarget, message: ExtensionMessage): Promise<void> {
  const internal: InternalMessage = { kind: "to-page", targetOrigin: page.origin, message };
  const options: Tabs.SendMessageOptionsType = { frameId: 0 };
  if (page.documentId !== null) options.documentId = page.documentId;
  await browser.tabs.sendMessage(page.tabId, internal, options).catch((error: unknown) => {
    // The document went away between the origin check and the send.
    log.debug("page did not take the message", error);
  });
}

const manager = new CaptureManager({
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  session: browser.storage.session,
  consent,
  log,
  // tabs.get rejects for a closed tab; that simply means there is no page left to answer.
  tabUrl: (tabId) => browser.tabs.get(tabId).then((tab) => tab.url, () => undefined),
  post,
  openSignIn: () => openWindow("about:blank", 520, 760),
  navigate: async (tabId, url) => {
    await browser.tabs.update(tabId, { url });
  },
  openApproval: (query) => openWindow(browser.runtime.getURL(`approve.html?${query.toString()}`), 480, 560),
  close: async (opened) => {
    if (opened.windowId !== null) await browser.windows.remove(opened.windowId);
    else if (opened.tabId !== null) await browser.tabs.remove(opened.tabId);
  },
  setAlarm: async (name, when) => {
    await browser.alarms.create(name, { when });
  },
  clearAlarm: async (name) => {
    await browser.alarms.clear(name);
  },
});

function report(what: string): (error: unknown) => void {
  return (error) => {
    log.error(what, error);
  };
}

// ---- Enabled origins and the bridge content script (EX-004, EX-011) ---------------------------

async function enabledWithAccess(): Promise<string[]> {
  const result: string[] = [];
  for (const origin of await origins.list()) {
    if (await browser.permissions.contains({ origins: [originPattern(origin)] })) result.push(origin);
  }
  return result;
}

async function refreshBridge(): Promise<void> {
  await syncBridge(browser.scripting, await enabledWithAccess());
}

async function enableOrigin(raw: string, tabId: number | null): Promise<void> {
  const origin = normaliseOrigin(raw);
  if (origin === null || originTrust(origin) === "refused") return;
  if (!(await browser.permissions.contains({ origins: [originPattern(origin)] }))) return;
  await origins.approve(origin);
  await refreshBridge();
  if (tabId !== null) await browser.tabs.reload(tabId);
}

async function revokeOrigin(origin: string): Promise<void> {
  await origins.revoke(origin);
  await consent.removeOrigin(origin);
  await manager.endOrigin(origin);
  await refreshBridge();
  const pattern = originPattern(origin);
  const stillUsed = (await origins.list()).some((other) => originPattern(other) === pattern);
  if (!stillUsed) await browser.permissions.remove({ origins: [pattern] });
}

browser.runtime.onInstalled.addListener(() => {
  refreshBridge().catch(report("could not register the bridge"));
});
browser.runtime.onStartup.addListener(() => {
  refreshBridge().catch(report("could not register the bridge"));
});
browser.permissions.onRemoved.addListener((removed) => {
  void (async () => {
    const gone = new Set(removed.origins ?? []);
    for (const origin of await origins.list()) {
      if (gone.has(originPattern(origin))) await revokeOrigin(origin);
    }
  })().catch(report("could not follow a removed permission"));
});

// ---- Messages --------------------------------------------------------------------------------

function fromExtensionPage(sender: Runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && sender.url?.startsWith(browser.runtime.getURL("")) === true;
}

async function onPageMessage(message: PageMessage, sender: Runtime.MessageSender): Promise<void> {
  const tab = sender.tab;
  const origin = normaliseOrigin(sender.url ?? tab?.url ?? "");
  if (tab?.id === undefined || origin === null || sender.frameId !== 0) return;
  // The bridge matches scheme+host; the exact origin (port) must be enabled too.
  if (!(await origins.isApproved(origin))) return;
  const page: PageTarget = { tabId: tab.id, origin, documentId: sender.documentId ?? null };
  if (message.type === "capture") await manager.capture(page, tab.active, message);
  else if (message.type === "cancel") await manager.cancel(page.tabId, message.requestId);
}

browser.runtime.onMessage.addListener((raw: unknown, sender: Runtime.MessageSender) => {
  const message = parseInternalMessage(raw);
  if (message === null) return undefined;
  if (message.kind === "page") {
    onPageMessage(message.message, sender).catch(report("page message failed"));
    return undefined;
  }
  if (!fromExtensionPage(sender)) return undefined;
  if (message.kind === "approval-result") {
    manager
      .approvalResult(message.approvalId, message.decision, message.hostsGranted)
      .catch(report("approval failed"));
  } else if (message.kind === "enable-origin") {
    enableOrigin(message.origin, message.tabId).catch(report("could not enable the origin"));
  } else if (message.kind === "revoke-origin") {
    revokeOrigin(message.origin).catch(report("could not revoke the origin"));
  }
  return undefined;
});

// ---- Watching the sign-in tab (rule 4), main frame only (EX-008) ------------------------------

const filter: WebRequest.RequestFilter = { urls: ["<all_urls>"], types: ["main_frame"] };
const resumeTimers = new Map<number, ReturnType<typeof setTimeout>>();

function observe(tabId: number, address: string | undefined): void {
  if (tabId >= 0) manager.observe(tabId, address).catch(report("observe failed"));
}

function armResume(tabId: number): void {
  // Short in-memory timer: the worker stays alive for it, and a lost one only skips a resume.
  clearTimeout(resumeTimers.get(tabId));
  resumeTimers.set(
    tabId,
    setTimeout(() => {
      resumeTimers.delete(tabId);
      manager.resume(tabId).catch(report("resume failed"));
    }, RESUME_DELAY_MS),
  );
}

browser.webRequest.onBeforeRedirect.addListener((details) => {
  observe(details.tabId, details.redirectUrl);
}, filter);
browser.webRequest.onBeforeRequest.addListener((details) => {
  observe(details.tabId, details.url);
}, filter);
browser.webRequest.onCompleted.addListener((details) => {
  const tabId = details.tabId;
  if (tabId < 0 || !isResumeTrigger(details)) return;
  manager
    .isWatching(tabId)
    .then((watching) => {
      if (watching) armResume(tabId);
    })
    .catch(report("resume check failed"));
}, filter);

browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) observe(details.tabId, details.url);
});
browser.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0) observe(details.tabId, details.url);
});
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined) observe(tabId, changeInfo.url);
});

// ---- Lifecycle -------------------------------------------------------------------------------

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) manager.pageCommitted(details.tabId).catch(report("navigation cleanup failed"));
});
browser.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(resumeTimers.get(tabId));
  resumeTimers.delete(tabId);
  manager.tabRemoved(tabId).catch(report("tab cleanup failed"));
});
browser.windows.onRemoved.addListener((windowId) => {
  manager.windowRemoved(windowId).catch(report("window cleanup failed"));
});
browser.alarms.onAlarm.addListener(() => {
  manager.alarm().catch(report("timeout handling failed"));
});

// A restarted worker may have missed alarms while it was stopped.
manager.alarm().catch(report("startup sweep failed"));
