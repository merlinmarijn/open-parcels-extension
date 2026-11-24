/** In-memory stand-ins for the browser APIs the pure modules take as parameters. */
import { CaptureManager, type CaptureDeps, type Opened, type PageTarget } from "../src/lib/captures.js";
import { ConsentStore } from "../src/lib/consent.js";
import type { Logger } from "../src/lib/log.js";
import type { CaptureFromPage, ExtensionMessage } from "../src/lib/protocol.js";
import type { KeyValueArea } from "../src/lib/storage.js";

export function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: (key) => Promise.resolve(key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: (items) => {
      for (const [key, value] of Object.entries(items)) data[key] = structuredClone(value);
      return Promise.resolve();
    },
  };
}

export const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export const PAGE_ORIGIN = "https://parcels.example.invalid";
export const PAGE: PageTarget = { tabId: 1, origin: PAGE_ORIGIN, documentId: "doc-1" };

export function capture(overrides: Partial<CaptureFromPage> = {}): CaptureFromPage {
  return {
    source: "open-parcels-page",
    type: "capture",
    requestId: "r1",
    url: "https://login.carrier.example.invalid/authorize?client_id=x",
    redirectPrefix: "carrierlogin://app.example.invalid/login",
    resumeUrl: null,
    ...overrides,
  };
}

/** A small fake browser: tabs with URLs, windows that can be opened and closed, alarms, a clock. */
export class FakeBrowser {
  time = 1_000_000;
  ids = 0;
  nextId = 100;
  tabUrls = new Map<number, string>([[PAGE.tabId, `${PAGE_ORIGIN}/sources`]]);
  posted: { page: PageTarget; message: ExtensionMessage }[] = [];
  openedApprovals: { query: URLSearchParams; opened: Opened }[] = [];
  openedSignIns: Opened[] = [];
  navigations: { tabId: number; url: string }[] = [];
  closed: Opened[] = [];
  alarms = new Map<string, number>();
  hostAccess = new Set<string>();
  failOpenSignIn = false;
  session = memoryArea();
  local = memoryArea();

  deps(): CaptureDeps {
    return {
      now: () => this.time,
      newId: () => `approval-${String(++this.ids)}`,
      session: this.session,
      consent: new ConsentStore(this.local, (pattern) => Promise.resolve(this.hostAccess.has(pattern))),
      log: silentLog,
      tabUrl: (tabId) => Promise.resolve(this.tabUrls.get(tabId)),
      post: (page, message) => {
        this.posted.push({ page, message });
        return Promise.resolve();
      },
      openSignIn: () => {
        if (this.failOpenSignIn) return Promise.reject(new Error("no windows"));
        const opened = this.open("about:blank");
        this.openedSignIns.push(opened);
        return Promise.resolve(opened);
      },
      navigate: (tabId, url) => {
        this.navigations.push({ tabId, url });
        return Promise.resolve();
      },
      openApproval: (query) => {
        const opened = this.open("approve.html");
        this.openedApprovals.push({ query, opened });
        return Promise.resolve(opened);
      },
      close: (opened) => {
        this.closed.push(opened);
        return Promise.resolve();
      },
      setAlarm: (name, when) => {
        this.alarms.set(name, when);
        return Promise.resolve();
      },
      clearAlarm: (name) => {
        this.alarms.delete(name);
        return Promise.resolve();
      },
    };
  }

  manager(): CaptureManager {
    return new CaptureManager(this.deps());
  }

  private open(url: string): Opened {
    const tabId = this.nextId++;
    const windowId = this.nextId++;
    this.tabUrls.set(tabId, url);
    return { tabId, windowId };
  }

  messages(): ExtensionMessage[] {
    return this.posted.map((entry) => entry.message);
  }
}
