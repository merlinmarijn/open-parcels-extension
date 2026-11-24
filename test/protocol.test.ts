import { describe, expect, it } from "vitest";
import {
  hostPermissionOrigins,
  isOwnWindowMessage,
  isValidRedirectPrefix,
  matchesPrefix,
  parsePageMessage,
  validateCapture,
  type CaptureFromPage,
} from "../src/lib/protocol.js";

const capture = (overrides: Partial<CaptureFromPage> = {}): CaptureFromPage => ({
  source: "open-parcels-page",
  type: "capture",
  requestId: "r1",
  url: "https://login.carrier.example.invalid/authorize?client_id=x",
  redirectPrefix: "carrierlogin://app.example.invalid/login",
  resumeUrl: null,
  ...overrides,
});

describe("parsePageMessage", () => {
  it("ignores foreign messages", () => {
    expect(parsePageMessage(null)).toBeNull();
    expect(parsePageMessage("hello")).toBeNull();
    expect(parsePageMessage({ type: "hello" })).toBeNull();
    expect(parsePageMessage({ source: "open-parcels-extension", type: "hello" })).toBeNull();
    expect(parsePageMessage({ source: "open-parcels-page", type: "other" })).toBeNull();
  });

  it("parses hello, cancel and capture", () => {
    expect(parsePageMessage({ source: "open-parcels-page", type: "hello" })).toEqual({ source: "open-parcels-page", type: "hello" });
    expect(parsePageMessage({ source: "open-parcels-page", type: "cancel", requestId: "a" })).toMatchObject({ requestId: "a" });
    expect(parsePageMessage({ ...capture(), extra: 1 })).toEqual(capture());
  });

  it("drops messages without a usable requestId", () => {
    expect(parsePageMessage({ source: "open-parcels-page", type: "cancel" })).toBeNull();
    expect(parsePageMessage({ ...capture(), requestId: "" })).toBeNull();
    expect(parsePageMessage({ ...capture(), requestId: 5 })).toBeNull();
  });

  it("keeps a capture with bad fields so it can be answered with invalid", () => {
    const parsed = parsePageMessage({ ...capture(), url: 42, resumeUrl: 7 });
    expect(parsed).toMatchObject({ url: "", resumeUrl: "" });
    expect(parsed?.type === "capture" && validateCapture(parsed)).toBe(false);
  });
});

describe("validateCapture", () => {
  it("accepts a well-formed capture", () => {
    expect(validateCapture(capture())).toBe(true);
    expect(validateCapture(capture({ resumeUrl: "https://login.carrier.example.invalid/done" }))).toBe(true);
    expect(validateCapture(capture({ redirectPrefix: "https://app.example.invalid/callback" }))).toBe(true);
  });

  it("requires https for url and resumeUrl", () => {
    expect(validateCapture(capture({ url: "http://login.carrier.example.invalid/" }))).toBe(false);
    expect(validateCapture(capture({ url: "javascript:alert(1)" }))).toBe(false);
    expect(validateCapture(capture({ resumeUrl: "http://login.carrier.example.invalid/" }))).toBe(false);
    expect(validateCapture(capture({ resumeUrl: "" }))).toBe(false);
  });

  it("refuses a prefix the sign-in address itself matches", () => {
    expect(validateCapture(capture({ redirectPrefix: "https://login.carrier.example.invalid/" }))).toBe(false);
  });
});

describe("isValidRedirectPrefix", () => {
  it.each([
    ["carrierlogin://app.example.invalid/login", true],
    ["carrierlogin:/x", true],
    ["https://app.example.invalid/cb", true],
    ["carrierlogin:", false],
    ["no-scheme/path", false],
    ["", false],
    ["https://", false],
    ["javascript:void", false],
    ["data:text/html", false],
    ["1abc://x", false],
  ])("%s → %s", (prefix, expected) => {
    expect(isValidRedirectPrefix(prefix)).toBe(expected);
  });
});

describe("matchesPrefix", () => {
  const prefix = "carrierlogin://app.example.invalid/login";
  it("matches addresses starting with the prefix", () => {
    expect(matchesPrefix(`${prefix}?code=abc&state=s`, prefix)).toBe(true);
    expect(matchesPrefix(prefix, prefix)).toBe(true);
  });
  it("treats the scheme case-insensitively, the rest exactly", () => {
    expect(matchesPrefix("CarrierLogin://app.example.invalid/login?code=1", prefix)).toBe(true);
    expect(matchesPrefix("carrierlogin://app.example.invalid/LOGIN?code=1", prefix)).toBe(false);
  });
  it("does not match other addresses", () => {
    expect(matchesPrefix("https://login.carrier.example.invalid/?redirect=carrierlogin://app.example.invalid/login", prefix)).toBe(false);
    expect(matchesPrefix(undefined, prefix)).toBe(false);
    expect(matchesPrefix("", prefix)).toBe(false);
  });
});

describe("hostPermissionOrigins", () => {
  it("collects http(s) hosts, skipping custom schemes", () => {
    expect(
      hostPermissionOrigins(capture({ resumeUrl: "https://resume.example.invalid/x" })),
    ).toEqual(["https://login.carrier.example.invalid/*", "https://resume.example.invalid/*"]);
  });
});

describe("isOwnWindowMessage", () => {
  const self = { location: { origin: "https://parcels.example.invalid" } };
  it("accepts only messages the page posted to itself", () => {
    expect(isOwnWindowMessage({ source: self, origin: "https://parcels.example.invalid" }, self)).toBe(true);
    expect(isOwnWindowMessage({ source: {}, origin: "https://parcels.example.invalid" }, self)).toBe(false);
    expect(isOwnWindowMessage({ source: self, origin: "https://evil.example.invalid" }, self)).toBe(false);
  });
});
