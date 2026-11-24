/**
 * Background (Chromium service worker / Firefox event page). Opens the carrier sign-in in its own
 * window, watches only that tab and hands the first address matching redirectPrefix back to the
 * open-parcels page that asked for it.
 */
import browser, { type Runtime, type Tabs, type WebRequest } from "webextension-polyfill";
import { OriginStore, isSameOrigin, normaliseOrigin } from "./lib/origins.js";
import {
  CAPTURE_TIMEOUT_MS,
  EXTENSION_SOURCE,
  RESUME_DELAY_MS,
  hostPermissionOrigins,
  matchesPrefix,
  validateCapture,
  type CancelReason,
  type CaptureFromPage,
  type ExtensionMessage,
} from "./lib/protocol.js";
import { isResumeTrigger, resumeTarget } from "./lib/resume.js";
import { isInternalMessage, type InternalMessage } from "./lib/runtime-messages.js";

/**
 * A running capture. Kept in memory; mirrored to storage.session (memory-only, never on disk) so a
 * Chromium service worker restart mid-sign-in does not lose track of the tab. Captured addresses
 * are never part of it.
 */
interface Session {
  requestId: string;
  pageTabId: number;
  /** The approved page origin that asked; results only ever go back to a document of this origin. */
  pageOrigin: string;
  /** Chromium's id of the exact page document that asked (absent in Firefox). */
  pageDocumentId: string | null;
  signInTabId: number;
  windowId: number | null;
  redirectPrefix: string;
  resumeUrl: string | null;
  resumes: number;
  deadline: number;
}

const SESSION_KEY = "sessions";
const sessions = new Map<number, Session>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const resumeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const origins = new OriginStore(browser.storage.local);

interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
const sessionArea = (browser.storage as unknown as { session?: SessionArea }).session;

async function persistSessions(): Promise<void> {
  if (sessionArea === undefined) return;
  await sessionArea.set({ [SESSION_KEY]: [...sessions.values()] });
}

function armTimeout(session: Session): void {
  clearTimeout(timers.get(session.signInTabId));
  const delay = Math.max(0, session.deadline - Date.now());
  timers.set(session.signInTabId, setTimeout(() => void finish(session.signInTabId, { reason: "timeout" }), delay));
}

const restored: Promise<void> = (async () => {
  if (sessionArea === undefined) return;
  const raw = (await sessionArea.get(SESSION_KEY))[SESSION_KEY];
  if (!Array.isArray(raw)) return;
  for (const item of raw as Session[]) {
    if (sessions.has(item.signInTabId)) continue;
    sessions.set(item.signInTabId, item);
    armTimeout(item);
  }
})().catch(() => undefined);

interface PageTarget {
  tabId: number;
  origin: string;
  documentId: string | null;
}

/**
 * Hands a message to the page that asked, never to whatever else now occupies its tab: the tab's
 * current top-level origin must still be the requesting one, the message goes to frame 0 (and on
 * Chromium to the exact document), and the content script posts it with that origin as
 * targetOrigin so the browser drops it on any mismatch.
 */
async function sendToPage(target: PageTarget, message: ExtensionMessage): Promise<void> {
  // tabs.get rejects once the tab is gone; then there is nobody left to tell.
  const tab = await browser.tabs.get(target.tabId).catch(() => null);
  if (!isSameOrigin(tab?.url, target.origin)) return;
  const internal: InternalMessage = { kind: "to-page", targetOrigin: target.origin, message };
  const options: Tabs.SendMessageOptionsType = { frameId: 0 };
  if (target.documentId !== null) options.documentId = target.documentId;
  await browser.tabs.sendMessage(target.tabId, internal, options).catch(() => undefined);
}

function pageOf(session: Session): PageTarget {
  return { tabId: session.pageTabId, origin: session.pageOrigin, documentId: session.pageDocumentId };
}

function cancelled(requestId: string, reason: CancelReason): ExtensionMessage {
  return { source: EXTENSION_SOURCE, type: "cancelled", requestId, reason };
}

type Outcome = { captured: string } | { reason: CancelReason } | { silent: true };

/** Ends a session exactly once: stops watching, closes its window, tells the page. */
async function finish(signInTabId: number, outcome: Outcome): Promise<void> {
  const session = sessions.get(signInTabId);
  if (session === undefined) return;
  sessions.delete(signInTabId);
  clearTimeout(timers.get(signInTabId));
  clearTimeout(resumeTimers.get(signInTabId));
  timers.delete(signInTabId);
  resumeTimers.delete(signInTabId);
  await persistSessions();

  if (!("reason" in outcome && outcome.reason === "closed")) {
    if (session.windowId !== null) await browser.windows.remove(session.windowId).catch(() => undefined);
    else await browser.tabs.remove(signInTabId).catch(() => undefined);
  }
  if ("captured" in outcome) {
    await sendToPage(pageOf(session), {
      source: EXTENSION_SOURCE,
      type: "captured",
      requestId: session.requestId,
      url: outcome.captured,
    });
  } else if ("reason" in outcome) {
    await sendToPage(pageOf(session), cancelled(session.requestId, outcome.reason));
  }
}

async function observe(tabId: number, address: string | undefined): Promise<void> {
  await restored;
  const session = sessions.get(tabId);
  if (session === undefined || address === undefined) return;
  if (matchesPrefix(address, session.redirectPrefix)) await finish(tabId, { captured: address });
}

// ---- Approval ---------------------------------------------------------------------------------

const pendingApprovals = new Map<string, { windowId: number | null; resolve: (allowed: boolean) => void }>();

async function askUser(pageOrigin: string, hosts: string[], originKnown: boolean): Promise<boolean> {
  const approvalId = crypto.randomUUID();
  const params = new URLSearchParams({ id: approvalId, origin: pageOrigin, mode: originKnown ? "hosts" : "origin" });
  for (const host of hosts) params.append("host", host);
  const url = browser.runtime.getURL(`approve.html?${params.toString()}`);
  return new Promise<boolean>((resolve) => {
    const entry = { windowId: null as number | null, resolve };
    pendingApprovals.set(approvalId, entry);
    browser.windows
      .create({ url, type: "popup", width: 460, height: 380 })
      .then((win) => {
        entry.windowId = win.id ?? null;
      })
      .catch(async () => {
        await browser.tabs.create({ url }).catch(() => undefined);
      });
  });
}

function settleApproval(approvalId: string, allowed: boolean): void {
  const entry = pendingApprovals.get(approvalId);
  if (entry === undefined) return;
  pendingApprovals.delete(approvalId);
  entry.resolve(allowed);
  if (entry.windowId !== null) void browser.windows.remove(entry.windowId).catch(() => undefined);
}

/** Rule 1, plus the optional host permission webRequest needs to see the sign-in redirect chain. */
async function ensureApproved(pageOrigin: string, capture: CaptureFromPage): Promise<boolean> {
  const approved = await origins.isApproved(pageOrigin);
  const hosts = hostPermissionOrigins(capture);
  const haveHosts = hosts.length === 0 || (await browser.permissions.contains({ origins: hosts }));
  if (approved && haveHosts) return true;
  const allowed = await askUser(pageOrigin, haveHosts ? [] : hosts, approved);
  if (allowed && !approved) await origins.approve(pageOrigin);
  return allowed;
}

// ---- Capture ----------------------------------------------------------------------------------

async function startCapture(page: PageTarget, capture: CaptureFromPage): Promise<void> {
  const pageTabId = page.tabId;
  const pageOrigin = page.origin;
  if (!validateCapture(capture)) {
    await sendToPage(page, cancelled(capture.requestId, "invalid"));
    return;
  }
  await restored;
  for (const session of sessions.values()) {
    if (session.pageTabId === pageTabId && session.requestId === capture.requestId) return;
  }
  if (!(await ensureApproved(pageOrigin, capture))) {
    await sendToPage(page, cancelled(capture.requestId, "denied"));
    return;
  }

  // Open on about:blank first so the listeners know the tab before the first request goes out.
  let tabId: number | undefined;
  let windowId: number | null = null;
  try {
    const win = await browser.windows.create({ url: "about:blank", type: "popup", width: 520, height: 760 });
    tabId = win.tabs?.[0]?.id;
    windowId = win.id ?? null;
  } catch {
    tabId = (await browser.tabs.create({ url: "about:blank", active: true })).id;
  }
  if (tabId === undefined) {
    await sendToPage(page, cancelled(capture.requestId, "closed"));
    return;
  }
  const session: Session = {
    requestId: capture.requestId,
    pageTabId,
    pageOrigin,
    pageDocumentId: page.documentId,
    signInTabId: tabId,
    windowId,
    redirectPrefix: capture.redirectPrefix,
    resumeUrl: capture.resumeUrl,
    resumes: 0,
    deadline: Date.now() + CAPTURE_TIMEOUT_MS,
  };
  sessions.set(tabId, session);
  armTimeout(session);
  await persistSessions();
  await browser.tabs.update(tabId, { url: capture.url });
}

async function cancelCapture(pageTabId: number, requestId: string): Promise<void> {
  await restored;
  for (const session of [...sessions.values()]) {
    if (session.pageTabId === pageTabId && session.requestId === requestId) {
      await finish(session.signInTabId, { silent: true });
    }
  }
}

function senderOrigin(sender: Runtime.MessageSender): string | null {
  const raw = sender.url ?? sender.tab?.url;
  return raw === undefined ? null : normaliseOrigin(raw);
}

browser.runtime.onMessage.addListener((raw: unknown, sender: Runtime.MessageSender) => {
  if (!isInternalMessage(raw)) return undefined;
  if (raw.kind === "approval-result") {
    if (sender.id === browser.runtime.id && sender.url?.startsWith(browser.runtime.getURL("")) === true) {
      settleApproval(raw.approvalId, raw.allowed);
    }
    return undefined;
  }
  if (raw.kind !== "page") return undefined;
  const pageTabId = sender.tab?.id;
  const pageOrigin = senderOrigin(sender);
  if (pageTabId === undefined || pageOrigin === null || sender.frameId !== 0) return undefined;
  const message = raw.message;
  const documentId = sender.documentId ?? null;
  if (message.type === "capture") void startCapture({ tabId: pageTabId, origin: pageOrigin, documentId }, message);
  else if (message.type === "cancel") void cancelCapture(pageTabId, message.requestId);
  return undefined;
});

// ---- Watching the sign-in tab (rule 4) --------------------------------------------------------

const filter: WebRequest.RequestFilter = { urls: ["<all_urls>"] };

browser.webRequest.onBeforeRedirect.addListener((details) => {
  if (details.tabId >= 0) void observe(details.tabId, details.redirectUrl);
}, filter);

browser.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId >= 0) void observe(details.tabId, details.url);
}, filter);

browser.webRequest.onCompleted.addListener((details) => {
  if (details.tabId < 0 || !isResumeTrigger(details)) return;
  const tabId = details.tabId;
  void restored.then(() => {
    if (!sessions.has(tabId)) return;
    clearTimeout(resumeTimers.get(tabId));
    resumeTimers.set(tabId, setTimeout(() => void resume(tabId), RESUME_DELAY_MS));
  });
}, filter);

async function resume(tabId: number): Promise<void> {
  resumeTimers.delete(tabId);
  const session = sessions.get(tabId);
  if (session === undefined) return;
  const target = resumeTarget({ resumeUrl: session.resumeUrl, resumes: session.resumes, done: false });
  if (target === null) return;
  session.resumes += 1;
  await persistSessions();
  await browser.tabs.update(tabId, { url: target }).catch(() => undefined);
}

browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) void observe(details.tabId, details.url);
});

browser.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0) void observe(details.tabId, details.url);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined) void observe(tabId, changeInfo.url);
});

browser.tabs.onRemoved.addListener((tabId) => {
  void restored.then(async () => {
    if (sessions.has(tabId)) await finish(tabId, { reason: "closed" });
    for (const session of [...sessions.values()]) {
      if (session.pageTabId === tabId) await finish(session.signInTabId, { silent: true });
    }
  });
});

// A new document in the page tab (navigation, reload) can never receive the result: end silently.
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void restored.then(async () => {
    for (const session of [...sessions.values()]) {
      if (session.pageTabId === details.tabId) await finish(session.signInTabId, { silent: true });
    }
  });
});

browser.windows.onRemoved.addListener((windowId) => {
  for (const [approvalId, entry] of pendingApprovals) {
    if (entry.windowId === windowId) settleApproval(approvalId, false);
  }
});
