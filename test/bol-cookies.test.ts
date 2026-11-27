import { describe, expect, it } from "vitest";
import { validateCapture } from "../src/lib/protocol.js";
import { FakeBrowser, PAGE, capture } from "./fakes.js";

const URL = "https://www.bol.com/nl/nl/account/bestellingen/overzicht/";
const COOKIE = "JSESSIONID=test-session";
const bol = () => capture({ url: "https://www.bol.com/nl/account/login.html?redirectUrl=%2Fnl%2Fnl%2Faccount%2Fbestellingen%2Foverzicht%2F", redirectPrefix: URL, cookieUrl: URL });

async function start(fake: FakeBrowser) {
  const manager = fake.manager();
  await manager.capture(PAGE, true, bol());
  await manager.approvalResult(fake.openedApprovals[0]?.query.get("id") ?? "", "once", true);
  return { manager, tab: fake.openedSignIns[0]?.tabId ?? -1 };
}

describe("Bol Cookie capture", () => {
  it("requires exact Bol addresses and refuses arbitrary cookie targets", () => {
    expect(validateCapture(bol())).toBe(true);
    for (const override of [{ cookieUrl: "https://evil.example/" }, { cookieUrl: `${URL}?x=1` }, { url: "https://login.evil.example/" }, { redirectPrefix: "https://www.bol.com/" }]) {
      expect(validateCapture({ ...bol(), ...override })).toBe(false);
    }
  });

  it("asks for session disclosure and host permission before opening sign-in", async () => {
    const fake = new FakeBrowser();
    await fake.manager().capture(PAGE, true, bol());
    expect(fake.openedApprovals[0]?.query.get("cookieCapture")).toBe("true");
    expect(fake.openedApprovals[0]?.query.getAll("host")).toEqual(["https://www.bol.com/*"]);
    expect(fake.openedSignIns).toHaveLength(0);
  });

  it("never mistakes an overview navigation for a captured redirect", async () => {
    const fake = new FakeBrowser();
    const { manager, tab } = await start(fake);
    await manager.observe(tab, URL);
    expect(fake.messages()).toEqual([]);
    await manager.headersSent(tab, "http-1", URL, [{ name: "Cookie", value: COOKIE }]);
    expect(JSON.stringify(fake.session.data)).not.toContain(COOKIE);
    await manager.requestCompleted(tab, "http-1", URL, 200);
    expect(fake.messages()).toEqual([{ source: "open-parcels-extension", type: "cookies_captured", requestId: "r1", cookie: COOKIE }]);
    expect(JSON.stringify(fake.session.data)).not.toContain(COOKIE);
  });

  it("ignores other tabs, paths and failed responses", async () => {
    const fake = new FakeBrowser();
    const { manager, tab } = await start(fake);
    await manager.headersSent(tab + 1, "other-tab", URL, [{ name: "cookie", value: COOKIE }]);
    await manager.requestCompleted(tab, "other-tab", URL, 200);
    await manager.headersSent(tab, "other-path", "https://www.bol.com/", [{ name: "cookie", value: COOKIE }]);
    await manager.requestCompleted(tab, "other-path", URL, 200);
    await manager.headersSent(tab, "denied", URL, [{ name: "cookie", value: COOKIE }]);
    await manager.requestCompleted(tab, "denied", URL, 403);
    await manager.requestCompleted(tab, "denied", URL, 200);
    expect(fake.messages()).toEqual([]);
  });

  it("drops cookies when requesting dashboard navigates elsewhere", async () => {
    const fake = new FakeBrowser();
    const { manager, tab } = await start(fake);
    await manager.headersSent(tab, "http-1", URL, [{ name: "cookie", value: COOKIE }]);
    fake.tabUrls.set(PAGE.tabId, "https://evil.example/");
    await manager.requestCompleted(tab, "http-1", URL, 200);
    expect(fake.messages()).toEqual([]);
  });

  it("requires host permission and never opens sign-in after refusal", async () => {
    const fake = new FakeBrowser();
    const manager = fake.manager();
    await manager.capture(PAGE, true, bol());
    await manager.approvalResult(fake.openedApprovals[0]?.query.get("id") ?? "", "once", false);
    expect(fake.openedSignIns).toHaveLength(0);
    expect(fake.messages()[0]).toMatchObject({ type: "cancelled", reason: "denied" });
  });

  it("forgets secrets on cancellation and asks again even after Always allow", async () => {
    const fake = new FakeBrowser();
    const { manager, tab } = await start(fake);
    await manager.headersSent(tab, "http-1", URL, [{ name: "cookie", value: COOKIE }]);
    await manager.cancel(PAGE.tabId, "r1");
    await manager.requestCompleted(tab, "http-1", URL, 200);
    expect(fake.messages()).toEqual([]);
    await manager.capture(PAGE, true, { ...bol(), requestId: "r2" });
    await manager.approvalResult(fake.openedApprovals[1]?.query.get("id") ?? "", "always", true);
    await manager.cancel(PAGE.tabId, "r2");
    await manager.capture(PAGE, true, { ...bol(), requestId: "r3" });
    expect(fake.openedApprovals).toHaveLength(3);
  });
});
