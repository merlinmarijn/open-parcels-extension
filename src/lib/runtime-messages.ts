/** Messages between the extension's own parts (content script, background, extension pages). */
import type { ExtensionMessage, PageMessage } from "./protocol.js";

export type InternalMessage =
  | { kind: "page"; message: PageMessage }
  | { kind: "to-page"; targetOrigin: string; message: ExtensionMessage }
  | { kind: "approval-result"; approvalId: string; allowed: boolean };

export function isInternalMessage(value: unknown): value is InternalMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "page" || kind === "to-page" || kind === "approval-result";
}
