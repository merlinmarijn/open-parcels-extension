/** Page protocol v1, see docs/extension-protocol.md in the open-parcels repository. */
import { isRecord } from "./storage.js";

export const PROTOCOL_VERSION = 1;
export const PAGE_SOURCE = "open-parcels-page";
export const EXTENSION_SOURCE = "open-parcels-extension";
export const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;
export const RESUME_DELAY_MS = 3000;
export const MAX_RESUMES = 3;

/**
 * `busy` (another approval for this page is open, or the tab is not active) and `error` (the
 * extension could not open the window) are additions; pages that predate them show a generic text.
 */
export type CancelReason = "closed" | "denied" | "invalid" | "timeout" | "busy" | "error";

export interface HelloFromPage {
  source: typeof PAGE_SOURCE;
  type: "hello";
}
export interface CaptureFromPage {
  source: typeof PAGE_SOURCE;
  type: "capture";
  requestId: string;
  url: string;
  redirectPrefix: string;
  resumeUrl: string | null;
}
export interface CancelFromPage {
  source: typeof PAGE_SOURCE;
  type: "cancel";
  requestId: string;
}
export type PageMessage = HelloFromPage | CaptureFromPage | CancelFromPage;

export type ExtensionMessage =
  | { source: typeof EXTENSION_SOURCE; type: "hello"; version: string; protocol: typeof PROTOCOL_VERSION }
  | { source: typeof EXTENSION_SOURCE; type: "captured"; requestId: string; url: string }
  | { source: typeof EXTENSION_SOURCE; type: "cancelled"; requestId: string; reason: CancelReason };


const MAX_ID_LENGTH = 200;
const MAX_URL_LENGTH = 8192;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * Shape check for anything arriving on window.postMessage. Returns null for messages that are not
 * ours (wrong source, unknown type, no usable requestId); those are ignored silently.
 * A capture with a requestId but bad fields still parses here; `validateCapture` decides `invalid`.
 */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (!isRecord(data) || data.source !== PAGE_SOURCE) return null;
  switch (data.type) {
    case "hello":
      return { source: PAGE_SOURCE, type: "hello" };
    case "cancel":
      return isRequestId(data.requestId) ? { source: PAGE_SOURCE, type: "cancel", requestId: data.requestId } : null;
    case "capture": {
      if (!isRequestId(data.requestId)) return null;
      return {
        source: PAGE_SOURCE,
        type: "capture",
        requestId: data.requestId,
        url: typeof data.url === "string" ? data.url : "",
        redirectPrefix: typeof data.redirectPrefix === "string" ? data.redirectPrefix : "",
        resumeUrl: typeof data.resumeUrl === "string" ? data.resumeUrl : data.resumeUrl === null ? null : "",
      };
    }
    default:
      return null;
  }
}

/**
 * A window message the page posted to itself: same window object and same origin. Everything else
 * (other frames, other windows, opener tricks) is ignored.
 */
export function isOwnWindowMessage(
  event: { source: unknown; origin: string },
  self: { location: { origin: string } },
): boolean {
  return event.source === self && event.origin === self.location.origin;
}

function parseUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(value);
  } catch {
    // Unparseable input is simply not a usable URL.
    return null;
  }
}

/** An http(s) URL with a host (https only when `httpsOnly`), or null. */
export function parseHttpUrl(value: string, httpsOnly: boolean): URL | null {
  const url = parseUrl(value);
  if (url === null || url.hostname.length === 0) return null;
  if (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:")) return url;
  return null;
}

export function isHttpsUrl(value: string): boolean {
  return parseHttpUrl(value, true) !== null;
}

const FORBIDDEN_PREFIX_SCHEMES = new Set(["javascript:", "data:", "blob:", "file:", "about:"]);

/**
 * A redirect prefix must be an absolute URL prefix with a scheme. http(s) prefixes need a host;
 * custom schemes (dhllogin://…) need something after the colon so a bare scheme cannot match
 * everything.
 */
export function isValidRedirectPrefix(value: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme?.[1] === undefined) return false;
  if (value.length > MAX_URL_LENGTH) return false;
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (FORBIDDEN_PREFIX_SCHEMES.has(protocol)) return false;
  if (value.length <= protocol.length) return false;
  if (protocol === "http:" || protocol === "https:") return parseHttpUrl(value, false) !== null;
  return true;
}

/**
 * Rule 2 plus a sanity guard: a prefix the sign-in address itself already starts with would
 * "capture" the carrier's login page on first load.
 */
export function validateCapture(message: CaptureFromPage): boolean {
  if (!isHttpsUrl(message.url)) return false;
  if (message.resumeUrl !== null && !isHttpsUrl(message.resumeUrl)) return false;
  if (!isValidRedirectPrefix(message.redirectPrefix)) return false;
  return !matchesPrefix(message.url, message.redirectPrefix);
}

/** Rule 4: the address starts with redirectPrefix. Plain string comparison, scheme case-insensitive. */
export function matchesPrefix(address: string | undefined, prefix: string): boolean {
  if (address === undefined || address.length === 0) return false;
  if (address.startsWith(prefix)) return true;
  const colon = prefix.indexOf(":");
  return (
    colon > 0 &&
    address.slice(0, colon).toLowerCase() === prefix.slice(0, colon).toLowerCase() &&
    address.slice(colon).startsWith(prefix.slice(colon))
  );
}

/** Origins the extension needs host access to so webRequest can see the redirect chain. */
export function hostPermissionOrigins(message: CaptureFromPage): string[] {
  const origins = new Set<string>();
  for (const candidate of [message.url, message.resumeUrl, message.redirectPrefix]) {
    if (candidate === null) continue;
    const url = parseHttpUrl(candidate, false);
    if (url !== null) origins.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...origins];
}
