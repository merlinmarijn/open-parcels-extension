/**
 * Messages between the extension's own parts (content script, background, extension pages).
 * Only the extension's own contexts can send them, but every field is still checked (EX-013).
 */
import { isDecision, type Decision } from "./consent.js";
import { parsePageMessage, type ExtensionMessage, type PageMessage } from "./protocol.js";
import { isRecord } from "./storage.js";

export type InternalMessage =
  | { kind: "page"; message: PageMessage }
  | { kind: "to-page"; targetOrigin: string; message: ExtensionMessage }
  | { kind: "approval-result"; approvalId: string; decision: Decision; hostsGranted: boolean }
  | { kind: "enable-origin"; origin: string; tabId: number | null }
  | { kind: "revoke-origin"; origin: string };

const MAX_FIELD_LENGTH = 8192;

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || value.source !== "open-parcels-extension") return false;
  switch (value.type) {
    case "hello":
      return typeof value.version === "string" && value.protocol === 1;
    case "captured":
      return isShortString(value.requestId) && isShortString(value.url);
    case "cancelled":
      return isShortString(value.requestId) && typeof value.reason === "string";
    default:
      return false;
  }
}

/** Parses an internal message, or null when any field is missing or of the wrong type. */
export function parseInternalMessage(value: unknown): InternalMessage | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "page": {
      const message = parsePageMessage(value.message);
      return message === null ? null : { kind: "page", message };
    }
    case "to-page":
      return isShortString(value.targetOrigin) && isExtensionMessage(value.message)
        ? { kind: "to-page", targetOrigin: value.targetOrigin, message: value.message }
        : null;
    case "approval-result":
      return isShortString(value.approvalId) && isDecision(value.decision) && typeof value.hostsGranted === "boolean"
        ? { kind: "approval-result", approvalId: value.approvalId, decision: value.decision, hostsGranted: value.hostsGranted }
        : null;
    case "enable-origin":
      return isShortString(value.origin) && (value.tabId === null || typeof value.tabId === "number")
        ? { kind: "enable-origin", origin: value.origin, tabId: value.tabId }
        : null;
    case "revoke-origin":
      return isShortString(value.origin) ? { kind: "revoke-origin", origin: value.origin } : null;
    default:
      return null;
  }
}
