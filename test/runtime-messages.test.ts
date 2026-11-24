import { describe, expect, it } from "vitest";
import { parseInternalMessage } from "../src/lib/runtime-messages.js";

describe("parseInternalMessage (EX-013)", () => {
  it("accepts well-formed messages", () => {
    expect(parseInternalMessage({ kind: "approval-result", approvalId: "a", decision: "once", hostsGranted: true })).toEqual({
      kind: "approval-result",
      approvalId: "a",
      decision: "once",
      hostsGranted: true,
    });
    expect(parseInternalMessage({ kind: "page", message: { source: "open-parcels-page", type: "cancel", requestId: "r" } })).toEqual({
      kind: "page",
      message: { source: "open-parcels-page", type: "cancel", requestId: "r" },
    });
    expect(parseInternalMessage({ kind: "enable-origin", origin: "https://a.example.invalid", tabId: null })).not.toBeNull();
  });

  it("rejects wrong field types instead of trusting them", () => {
    expect(parseInternalMessage({ kind: "approval-result", approvalId: "a", decision: "yes", hostsGranted: true })).toBeNull();
    expect(parseInternalMessage({ kind: "approval-result", approvalId: "a", decision: "once", hostsGranted: "true" })).toBeNull();
    expect(parseInternalMessage({ kind: "approval-result", approvalId: "", decision: "once", hostsGranted: true })).toBeNull();
    expect(parseInternalMessage({ kind: "page", message: { type: "capture" } })).toBeNull();
    expect(parseInternalMessage({ kind: "to-page", targetOrigin: "https://a.example.invalid", message: { type: "captured" } })).toBeNull();
    expect(parseInternalMessage({ kind: "enable-origin", origin: "https://a.example.invalid", tabId: "1" })).toBeNull();
    expect(parseInternalMessage({ kind: "other" })).toBeNull();
    expect(parseInternalMessage(null)).toBeNull();
  });
});
