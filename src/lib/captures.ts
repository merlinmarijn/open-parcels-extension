/**
 * Capture lifecycle, free of browser globals so it can be tested with fakes (EX-016).
 *
 * One request per (page tab, requestId) is recorded the moment `capture` arrives (EX-007, EX-012)
 * and goes approval → sign-in → end. All state lives in storage.session (memory only) and every
 * deadline is an alarm, so a stopped MV3 service worker picks up where it left off (EX-006).
 * Every entry point runs through one queue, so events never interleave half-way.
 */
import { grantFor, type ConsentStore, type Decision } from "./consent.js";
import type { Logger } from "./log.js";
import { isSameOrigin } from "./origins.js";
import {
  CAPTURE_TIMEOUT_MS,
  EXTENSION_SOURCE,
  matchesPrefix,
  validateCapture,
  type CancelReason,
  type CaptureFromPage,
  type ExtensionMessage,
} from "./protocol.js";
import { resumeTarget } from "./resume.js";
import { Serial, isRecord, isStringArray, type KeyValueArea } from "./storage.js";

export const STATE_KEY = "captureState";
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** After an explicit Deny, captures from that origin are refused without a prompt for this long. */
export const DENY_COOLDOWN_MS = 10 * 60 * 1000;
export const ALARM_PREFIX = "capture:";

/** The page document that asked. Results only ever go back to it (EX-001). */
export interface PageTarget {
  tabId: number;
  origin: string;
  /** Chromium's id of the exact document; null where the browser has none. */
  documentId: string | null;
}

/** A window or tab the extension opened. Either id may be missing (tab fallback, odd browsers). */
export interface Opened {
  tabId: number | null;
  windowId: number | null;
}

interface Request {
  key: string;
  page: PageTarget;
  capture: CaptureFromPage;
  stage: "approval" | "sign-in";
  deadline: number;
  approvalId: string | null;
  approval: Opened | null;
  hosts: string[];
  signIn: Opened | null;
  resumes: number;
}

interface State {
  requests: Request[];
  /** page origin → time until which it is refused without a prompt */
  cooldowns: Record<string, number>;
}

export interface CaptureDeps {
  now(): number;
  newId(): string;
  session: KeyValueArea;
  consent: ConsentStore;
  log: Logger;
  /** Current top-level address of a tab, undefined when it is gone or unknown. */
  tabUrl(tabId: number): Promise<string | undefined>;
  post(page: PageTarget, message: ExtensionMessage): Promise<void>;
  /** Opens an empty popup window (or tab) for the sign-in. */
  openSignIn(): Promise<Opened>;
  navigate(tabId: number, url: string): Promise<void>;
  openApproval(query: URLSearchParams): Promise<Opened>;
  close(opened: Opened): Promise<void>;
  setAlarm(name: string, when: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
}

type Outcome = { captured: string } | { reason: CancelReason } | { silent: true };

export function requestKey(tabId: number, requestId: string): string {
  return `${String(tabId)}:${requestId}`;
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isOpened(value: unknown): value is Opened {
  return isRecord(value) && isNumberOrNull(value.tabId) && isNumberOrNull(value.windowId);
}

function isPageTarget(value: unknown): value is PageTarget {
  return (
    isRecord(value) &&
    typeof value.tabId === "number" &&
    typeof value.origin === "string" &&
    (value.documentId === null || typeof value.documentId === "string")
  );
}

function isCapture(value: unknown): value is CaptureFromPage {
  return (
    isRecord(value) &&
    value.type === "capture" &&
    typeof value.requestId === "string" &&
    typeof value.url === "string" &&
    typeof value.redirectPrefix === "string" &&
    (value.resumeUrl === null || typeof value.resumeUrl === "string")
  );
}

function isRequest(value: unknown): value is Request {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    isPageTarget(value.page) &&
    isCapture(value.capture) &&
    (value.stage === "approval" || value.stage === "sign-in") &&
    typeof value.deadline === "number" &&
    (value.approvalId === null || typeof value.approvalId === "string") &&
    (value.approval === null || isOpened(value.approval)) &&
    isStringArray(value.hosts) &&
    (value.signIn === null || isOpened(value.signIn)) &&
    typeof value.resumes === "number"
  );
}

function parseState(raw: unknown): State {
  if (!isRecord(raw)) return { requests: [], cooldowns: {} };
  const requests = Array.isArray(raw.requests) ? raw.requests.filter(isRequest) : [];
  const cooldowns: Record<string, number> = {};
  if (isRecord(raw.cooldowns)) {
    for (const [origin, until] of Object.entries(raw.cooldowns)) {
      if (typeof until === "number") cooldowns[origin] = until;
    }
  }
  return { requests, cooldowns };
}

export class CaptureManager {
  private readonly queue = new Serial();
  private cached: State | null = null;

  constructor(private readonly deps: CaptureDeps) {}

  // ---- Entry points (each one queued) --------------------------------------------------------

  /** `active`: whether the page tab is the active tab; background tabs cannot start a sign-in. */
  capture(page: PageTarget, active: boolean, capture: CaptureFromPage): Promise<void> {
    return this.queue.run(() => this.startCapture(page, active, capture));
  }

  cancel(tabId: number, requestId: string): Promise<void> {
    return this.queue.run(async () => {
      const request = (await this.state()).requests.find((item) => item.key === requestKey(tabId, requestId));
      if (request !== undefined) await this.end(request, { silent: true });
    });
  }

  approvalResult(approvalId: string, decision: Decision, hostsGranted: boolean): Promise<void> {
    return this.queue.run(async () => {
      const state = await this.state();
      const request = state.requests.find((item) => item.stage === "approval" && item.approvalId === approvalId);
      if (request === undefined) {
        this.deps.log.debug("approval result for an unknown or finished request");
        return;
      }
      await this.deps.consent.remember(grantFor(request.page.origin, request.capture), decision, request.hosts, hostsGranted);
      if (decision === "deny") {
        state.cooldowns[request.page.origin] = this.deps.now() + DENY_COOLDOWN_MS;
        await this.end(request, { reason: "denied" });
        return;
      }
      await this.closeQuietly(request.approval);
      request.approval = null;
      await this.openSignIn(request);
    });
  }

  /** An address seen in some tab (navigation, redirect, request). */
  observe(tabId: number, address: string | undefined): Promise<void> {
    if (address === undefined) return Promise.resolve();
    return this.queue.run(async () => {
      const request = (await this.state()).requests.find((item) => item.stage === "sign-in" && item.signIn?.tabId === tabId);
      if (request !== undefined && matchesPrefix(address, request.capture.redirectPrefix)) {
        await this.end(request, { captured: address });
      }
    });
  }

  /** Whether `tabId` is a sign-in tab being watched (to arm the resume timer). */
  isWatching(tabId: number): Promise<boolean> {
    return this.queue.run(async () => (await this.signInRequest(tabId)) !== undefined);
  }

  /** Rule 5: navigate a sign-in tab that went blank back to resumeUrl. */
  resume(tabId: number): Promise<void> {
    return this.queue.run(async () => {
      const request = await this.signInRequest(tabId);
      if (request === undefined) return;
      const target = resumeTarget({ resumeUrl: request.capture.resumeUrl, resumes: request.resumes });
      if (target === null) return;
      request.resumes += 1;
      await this.persist();
      await this.deps.navigate(tabId, target).catch((error: unknown) => {
        this.deps.log.warn("could not resume the sign-in tab", error);
      });
    });
  }

  tabRemoved(tabId: number): Promise<void> {
    return this.queue.run(async () => {
      for (const request of [...(await this.state()).requests]) {
        if (request.signIn?.tabId === tabId) await this.end(request, { reason: "closed" });
        else if (request.approval?.tabId === tabId) await this.end(request, { reason: "denied" });
        else if (request.page.tabId === tabId) await this.end(request, { silent: true });
      }
    });
  }

  windowRemoved(windowId: number): Promise<void> {
    return this.queue.run(async () => {
      for (const request of [...(await this.state()).requests]) {
        if (request.signIn?.windowId === windowId) await this.end(request, { reason: "closed" });
        else if (request.approval?.windowId === windowId) await this.end(request, { reason: "denied" });
      }
    });
  }

  /** A new top-level document in a tab: its earlier requests can never be answered (EX-001/007). */
  pageCommitted(tabId: number): Promise<void> {
    return this.queue.run(async () => {
      for (const request of [...(await this.state()).requests]) {
        if (request.page.tabId === tabId) await this.end(request, { silent: true });
      }
    });
  }

  /** Revoked origin: stop everything it started, without telling it (EX-011). */
  endOrigin(origin: string): Promise<void> {
    return this.queue.run(async () => {
      const state = await this.state();
      for (const request of [...state.requests]) {
        if (request.page.origin === origin) await this.end(request, { silent: true });
      }
      Reflect.deleteProperty(state.cooldowns, origin);
      await this.persist();
    });
  }

  /** An alarm fired; also sweeps anything overdue (alarms can be late or lost). */
  alarm(): Promise<void> {
    return this.queue.run(() => this.sweep());
  }

  // ---- Internals -------------------------------------------------------------------------------

  private async startCapture(page: PageTarget, active: boolean, capture: CaptureFromPage): Promise<void> {
    if (!validateCapture(capture)) {
      await this.deliver(page, cancelled(capture.requestId, "invalid"));
      return;
    }
    const state = await this.state();
    const key = requestKey(page.tabId, capture.requestId);
    if (state.requests.some((item) => item.key === key)) return;
    if (!active) {
      await this.deliver(page, cancelled(capture.requestId, "busy"));
      return;
    }
    if ((state.cooldowns[page.origin] ?? 0) > this.deps.now()) {
      await this.deliver(page, cancelled(capture.requestId, "denied"));
      return;
    }
    // One request per tab: a newer capture from the same tab replaces the older one.
    for (const older of state.requests.filter((item) => item.page.tabId === page.tabId)) {
      await this.end(older, { silent: true });
    }
    // One approval window per origin at a time.
    if (state.requests.some((item) => item.page.origin === page.origin && item.stage === "approval")) {
      await this.deliver(page, cancelled(capture.requestId, "busy"));
      return;
    }
    const consent = await this.deps.consent.check(page.origin, capture);
    const request: Request = {
      key,
      page,
      capture,
      stage: "approval",
      deadline: this.deps.now() + APPROVAL_TIMEOUT_MS,
      approvalId: null,
      approval: null,
      hosts: consent.hosts,
      signIn: null,
      resumes: 0,
    };
    state.requests.push(request);
    if (consent.ask) await this.askApproval(request);
    else await this.openSignIn(request);
  }

  private async askApproval(request: Request): Promise<void> {
    const approvalId = this.deps.newId();
    request.approvalId = approvalId;
    const grant = grantFor(request.page.origin, request.capture);
    const query = new URLSearchParams({
      id: approvalId,
      origin: grant.origin,
      signInHost: grant.signInHost,
      target: grant.target,
    });
    for (const host of request.hosts) query.append("host", host);
    // Persist before the window exists, so a result arriving at a restarted worker is known.
    await this.persist();
    await this.deps.setAlarm(ALARM_PREFIX + request.key, request.deadline);
    try {
      request.approval = await this.deps.openApproval(query);
    } catch (error) {
      this.deps.log.error("could not open the approval window", error);
      await this.end(request, { reason: "error" });
      return;
    }
    await this.persist();
  }

  private async openSignIn(request: Request): Promise<void> {
    request.stage = "sign-in";
    request.deadline = this.deps.now() + CAPTURE_TIMEOUT_MS;
    let opened: Opened;
    try {
      opened = await this.deps.openSignIn();
    } catch (error) {
      this.deps.log.error("could not open the sign-in window", error);
      await this.end(request, { reason: "error" });
      return;
    }
    request.signIn = opened;
    const tabId = opened.tabId;
    if (tabId === null) {
      this.deps.log.error("the sign-in window has no tab");
      await this.end(request, { reason: "error" });
      return;
    }
    await this.persist();
    await this.deps.setAlarm(ALARM_PREFIX + request.key, request.deadline);
    try {
      await this.deps.navigate(tabId, request.capture.url);
    } catch (error) {
      this.deps.log.error("could not load the sign-in page", error);
      await this.end(request, { reason: "error" });
    }
  }

  /** Ends a request exactly once: forgets it, closes its windows, tells the page. */
  private async end(request: Request, outcome: Outcome): Promise<void> {
    const state = await this.state();
    const index = state.requests.indexOf(request);
    if (index < 0) return;
    state.requests.splice(index, 1);
    await this.persist();
    await this.deps.clearAlarm(ALARM_PREFIX + request.key);
    await this.closeQuietly(request.approval);
    const signInClosedByUser = "reason" in outcome && outcome.reason === "closed";
    if (!signInClosedByUser) await this.closeQuietly(request.signIn);
    const requestId = request.capture.requestId;
    if ("captured" in outcome) {
      await this.deliver(request.page, { source: EXTENSION_SOURCE, type: "captured", requestId, url: outcome.captured });
    } else if ("reason" in outcome) {
      await this.deliver(request.page, cancelled(requestId, outcome.reason));
    }
  }

  /** EX-001: only if the page tab still shows the requesting origin; otherwise drop it. */
  private async deliver(page: PageTarget, message: ExtensionMessage): Promise<void> {
    if (!isSameOrigin(await this.deps.tabUrl(page.tabId), page.origin)) {
      this.deps.log.warn("result dropped: the page tab no longer shows the origin that asked");
      return;
    }
    await this.deps.post(page, message);
  }

  private async closeQuietly(opened: Opened | null): Promise<void> {
    if (opened === null) return;
    await this.deps.close(opened).catch((error: unknown) => {
      // Usually already closed by the user; nothing left to do.
      this.deps.log.debug("close failed", error);
    });
  }

  private async sweep(): Promise<void> {
    const state = await this.state();
    const now = this.deps.now();
    for (const request of [...state.requests]) {
      if (request.deadline <= now) await this.end(request, { reason: "timeout" });
    }
    for (const [origin, until] of Object.entries(state.cooldowns)) {
      if (until <= now) Reflect.deleteProperty(state.cooldowns, origin);
    }
    await this.persist();
  }

  private async signInRequest(tabId: number): Promise<Request | undefined> {
    return (await this.state()).requests.find((item) => item.stage === "sign-in" && item.signIn?.tabId === tabId);
  }

  private async state(): Promise<State> {
    if (this.cached === null) {
      this.cached = parseState((await this.deps.session.get(STATE_KEY))[STATE_KEY]);
    }
    return this.cached;
  }

  private async persist(): Promise<void> {
    await this.deps.session.set({ [STATE_KEY]: await this.state() });
  }
}

function cancelled(requestId: string, reason: CancelReason): ExtensionMessage {
  return { source: EXTENSION_SOURCE, type: "cancelled", requestId, reason };
}

