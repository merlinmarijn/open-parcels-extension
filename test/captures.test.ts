import { describe, expect, it } from "vitest";
import { ALARM_PREFIX, APPROVAL_TIMEOUT_MS, DENY_COOLDOWN_MS, requestKey } from "../src/lib/captures.js";
import { CAPTURE_TIMEOUT_MS } from "../src/lib/protocol.js";
import { FakeBrowser, PAGE, PAGE_ORIGIN, capture } from "./fakes.js";

const CODE_URL = "carrierlogin://app.example.invalid/login?code=c0de&state=s1";

function approvalId(fake: FakeBrowser, index = 0): string {
  return fake.openedApprovals[index]?.query.get("id") ?? "";
}

function signInTab(fake: FakeBrowser, index = 0): number {
  return fake.openedSignIns[index]?.tabId ?? -1;
}

/** Runs a capture through the approval window to an open sign-in. */
async function started(fake: FakeBrowser) {
  const manager = fake.manager();
  await manager.capture(PAGE, true, capture());
  await manager.approvalResult(approvalId(fake), "once", true);
  return manager;
}

describe("approval", () => {
  it("asks first, showing the page origin, sign-in host and redirect target", async () => {
    const fake = new FakeBrowser();
    await fake.manager().capture(PAGE, true, capture());
    const query = fake.openedApprovals[0]?.query;
    expect(query?.get("origin")).toBe(PAGE_ORIGIN);
    expect(query?.get("signInHost")).toBe("login.carrier.example.invalid");
    expect(query?.get("target")).toBe("carrierlogin://app.example.invalid");
    expect(query?.getAll("host")).toEqual(["https://login.carrier.example.invalid/*"]);
    expect(fake.openedSignIns).toHaveLength(0);
  });

  it("opens the sign-in after Allow once, and asks again next time", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    expect(fake.navigations).toEqual([{ tabId: signInTab(fake), url: capture().url }]);
    await manager.observe(signInTab(fake), CODE_URL);
    fake.hostAccess.add("https://login.carrier.example.invalid/*");
    await manager.capture(PAGE, true, capture({ requestId: "r2" }));
    expect(fake.openedApprovals).toHaveLength(2);
  });

  it("skips the prompt after Always allow for the same origin, sign-in host and target", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.approvalResult(approvalId(fake), "always", true);
    fake.hostAccess.add("https://login.carrier.example.invalid/*");
    await manager.observe(signInTab(fake), CODE_URL);
    await manager.capture(PAGE, true, capture({ requestId: "r2" }));
    expect(fake.openedApprovals).toHaveLength(1);
    expect(fake.openedSignIns).toHaveLength(2);
  });

  it("asks again when an always-allowed origin wants another redirect target", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.approvalResult(approvalId(fake), "always", true);
    fake.hostAccess.add("https://login.carrier.example.invalid/*");
    await manager.observe(signInTab(fake), CODE_URL);
    await manager.capture(PAGE, true, capture({ requestId: "r2", redirectPrefix: "otherapp://x.example.invalid/cb" }));
    expect(fake.openedApprovals).toHaveLength(2);
  });

  it("does not ask again for host access the user refused (EX-014)", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.approvalResult(approvalId(fake), "always", false);
    await manager.observe(signInTab(fake), CODE_URL);
    await manager.capture(PAGE, true, capture({ requestId: "r2" }));
    expect(fake.openedApprovals).toHaveLength(1);
    expect(fake.openedSignIns).toHaveLength(2);
  });

  it("Deny answers denied and refuses that origin without a prompt for a while", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.approvalResult(approvalId(fake), "deny", false);
    await manager.capture(PAGE, true, capture({ requestId: "r2" }));
    expect(fake.openedApprovals).toHaveLength(1);
    expect(fake.messages()).toEqual([
      { source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "denied" },
      { source: "open-parcels-extension", type: "cancelled", requestId: "r2", reason: "denied" },
    ]);
    fake.time += DENY_COOLDOWN_MS + 1;
    await manager.alarm();
    await manager.capture(PAGE, true, capture({ requestId: "r3" }));
    expect(fake.openedApprovals).toHaveLength(2);
  });

  it("closing the approval window answers denied (EX-010: also when it is a tab)", async () => {
    for (const viaTab of [false, true]) {
      const fake = new FakeBrowser();
      const manager = fake.manager();
      await manager.capture(PAGE, true, capture());
      const opened = fake.openedApprovals[0]?.opened;
      if (viaTab) await manager.tabRemoved(opened?.tabId ?? -1);
      else await manager.windowRemoved(opened?.windowId ?? -1);
      expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "denied" }]);
    }
  });

  it("an unanswered approval times out (EX-010)", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    expect(fake.alarms.get(ALARM_PREFIX + requestKey(PAGE.tabId, "r1"))).toBe(fake.time + APPROVAL_TIMEOUT_MS);
    fake.time += APPROVAL_TIMEOUT_MS;
    await manager.alarm();
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "timeout" }]);
    expect(fake.closed).toContainEqual(fake.openedApprovals[0]?.opened);
  });
});

describe("rate limiting and de-duplication (EX-002, EX-012)", () => {
  it("ignores a repeated capture with the same requestId", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await Promise.all([manager.capture(PAGE, true, capture()), manager.capture(PAGE, true, capture())]);
    expect(fake.openedApprovals).toHaveLength(1);
  });

  it("keeps one request per tab: a newer capture replaces the older one silently", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.capture(PAGE, true, capture({ requestId: "r2" }));
    expect(fake.openedApprovals).toHaveLength(2);
    expect(fake.closed).toContainEqual(fake.openedApprovals[0]?.opened);
    expect(fake.messages()).toEqual([]);
  });

  it("allows one open approval per origin; other tabs get busy", async () => {
    const fake = new FakeBrowser();
    fake.tabUrls.set(2, `${PAGE_ORIGIN}/other`);
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.capture({ ...PAGE, tabId: 2 }, true, capture());
    expect(fake.openedApprovals).toHaveLength(1);
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "busy" }]);
  });

  it("refuses captures from a tab that is not active", async () => {
    const fake = new FakeBrowser();
    await fake.manager().capture(PAGE, false, capture());
    expect(fake.openedApprovals).toHaveLength(0);
    expect(fake.messages()[0]).toMatchObject({ type: "cancelled", reason: "busy" });
  });

  it("answers invalid without opening anything", async () => {
    const fake = new FakeBrowser();
    await fake.manager().capture(PAGE, true, capture({ url: "http://login.carrier.example.invalid/" }));
    expect(fake.openedApprovals).toHaveLength(0);
    expect(fake.messages()[0]).toMatchObject({ type: "cancelled", reason: "invalid" });
  });
});

describe("capture and delivery", () => {
  it("delivers the first matching address once and closes the window", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.observe(signInTab(fake), "https://login.carrier.example.invalid/step2");
    await manager.observe(signInTab(fake), CODE_URL);
    await manager.observe(signInTab(fake), CODE_URL);
    expect(fake.posted).toEqual([
      { page: PAGE, message: { source: "open-parcels-extension", type: "captured", requestId: "r1", url: CODE_URL } },
    ]);
    expect(fake.closed).toContainEqual(fake.openedSignIns[0]);
  });

  it("ignores matching addresses in other tabs", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.observe(PAGE.tabId, CODE_URL);
    expect(fake.posted).toEqual([]);
  });

  it("EX-001: drops the result when the page tab now shows another origin", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    fake.tabUrls.set(PAGE.tabId, "https://evil.example.invalid/");
    await manager.observe(signInTab(fake), CODE_URL);
    expect(fake.posted).toEqual([]);
  });

  it("EX-001/EX-007: a new document in the page tab ends the capture silently", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.pageCommitted(PAGE.tabId);
    expect(fake.closed).toContainEqual(fake.openedSignIns[0]);
    await manager.observe(signInTab(fake), CODE_URL);
    expect(fake.posted).toEqual([]);
  });

  it("EX-007: cancel while the approval is open closes it and never opens the sign-in", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    await manager.cancel(PAGE.tabId, "r1");
    await manager.approvalResult(approvalId(fake), "once", true);
    expect(fake.openedSignIns).toHaveLength(0);
    expect(fake.closed).toContainEqual(fake.openedApprovals[0]?.opened);
    expect(fake.posted).toEqual([]);
  });

  it("the user closing the sign-in answers closed", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.tabRemoved(signInTab(fake));
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "closed" }]);
  });

  it("a window that cannot be opened answers error", async () => {
    const fake = new FakeBrowser();
    fake.failOpenSignIn = true;
    await started(fake);
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "error" }]);
  });

  it("revoking the origin ends its captures silently", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.endOrigin(PAGE_ORIGIN);
    await manager.observe(signInTab(fake), CODE_URL);
    expect(fake.posted).toEqual([]);
  });

  it("resumes at most three times", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    const resumeUrl = "https://login.carrier.example.invalid/resume";
    await manager.capture(PAGE, true, capture({ resumeUrl }));
    await manager.approvalResult(approvalId(fake), "once", true);
    for (let i = 0; i < 5; i += 1) await manager.resume(signInTab(fake));
    expect(fake.navigations.filter((item) => item.url === resumeUrl)).toHaveLength(3);
  });
});

describe("service-worker restarts (EX-006)", () => {
  it("a new manager over the same session storage continues the sign-in", async () => {
    const fake = new FakeBrowser();
    await started(fake);
    const restarted = fake.manager();
    expect(await restarted.isWatching(signInTab(fake))).toBe(true);
    await restarted.observe(signInTab(fake), CODE_URL);
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "captured", requestId: "r1", url: CODE_URL }]);
  });

  it("an approval answered after a restart still opens the sign-in", async () => {
    const fake = new FakeBrowser();
    await fake.manager().capture(PAGE, true, capture());
    await fake.manager().approvalResult(approvalId(fake), "once", true);
    expect(fake.openedSignIns).toHaveLength(1);
  });

  it("the sign-in deadline is an alarm, and a restarted worker sweeps overdue requests", async () => {
    const fake = new FakeBrowser();
    await started(fake);
    expect(fake.alarms.get(ALARM_PREFIX + requestKey(PAGE.tabId, "r1"))).toBe(fake.time + CAPTURE_TIMEOUT_MS);
    fake.time += CAPTURE_TIMEOUT_MS + 1;
    await fake.manager().alarm();
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cancelled", requestId: "r1", reason: "timeout" }]);
    expect(fake.alarms.size).toBe(0);
  });

  it("never stores the captured address", async () => {
    const fake = new FakeBrowser();
    const manager = await started(fake);
    await manager.observe(signInTab(fake), CODE_URL);
    expect(JSON.stringify(fake.session.data)).not.toContain("c0de");
  });

  it("ignores corrupt stored state", async () => {
    const fake = new FakeBrowser();
    fake.session.data.captureState = { requests: [{ key: 1 }, "x"], cooldowns: { a: "soon" } };
    const manager = fake.manager();
    await manager.capture(PAGE, true, capture());
    expect(fake.openedApprovals).toHaveLength(1);
  });
});
