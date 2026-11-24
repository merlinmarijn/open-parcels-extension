import { describe, expect, it } from "vitest";
import { ConsentStore, grantFor, redirectTarget } from "../src/lib/consent.js";
import { PAGE_ORIGIN, capture, memoryArea } from "./fakes.js";

describe("redirectTarget", () => {
  it("reduces a prefix to what the page will receive: scheme and host", () => {
    expect(redirectTarget("https://shop.example.invalid/callback?x=1")).toBe("https://shop.example.invalid");
    expect(redirectTarget("carrierlogin://app.example.invalid/login")).toBe("carrierlogin://app.example.invalid");
    expect(redirectTarget("carrierlogin:/path")).toBe("carrierlogin:");
  });
});

describe("ConsentStore", () => {
  const host = "https://login.carrier.example.invalid/*";

  it("asks without a grant, and lists host access not yet held", async () => {
    const store = new ConsentStore(memoryArea(), () => Promise.resolve(false));
    expect(await store.check(PAGE_ORIGIN, capture())).toEqual({ ask: true, hosts: [host] });
  });

  it("an always grant plus host access means no question", async () => {
    const store = new ConsentStore(memoryArea(), () => Promise.resolve(true));
    await store.remember(grantFor(PAGE_ORIGIN, capture()), "always", [], true);
    expect(await store.check(PAGE_ORIGIN, capture())).toEqual({ ask: false, hosts: [] });
    expect(await store.check("https://other.example.invalid", capture())).toEqual({ ask: true, hosts: [] });
  });

  it("a grant is bound to the sign-in host as well", async () => {
    const store = new ConsentStore(memoryArea(), () => Promise.resolve(true));
    await store.remember(grantFor(PAGE_ORIGIN, capture()), "always", [], true);
    const other = capture({ url: "https://id.unrelated.example.invalid/authorize" });
    expect((await store.check(PAGE_ORIGIN, other)).ask).toBe(true);
  });

  it("remembers refused host access, and once/deny store no grant", async () => {
    const store = new ConsentStore(memoryArea(), () => Promise.resolve(false));
    await store.remember(grantFor(PAGE_ORIGIN, capture()), "once", [host], false);
    expect(await store.declined()).toEqual([host]);
    expect(await store.grants()).toEqual([]);
    await store.remember(grantFor(PAGE_ORIGIN, capture()), "deny", [], false);
    expect(await store.grants()).toEqual([]);
    expect(await store.check(PAGE_ORIGIN, capture())).toEqual({ ask: true, hosts: [] });
    await store.forgetDeclined(host);
    expect(await store.declined()).toEqual([]);
  });

  it("concurrent grants are not lost, and removeOrigin drops only that origin", async () => {
    const store = new ConsentStore(memoryArea(), () => Promise.resolve(true));
    const other = "https://other.example.invalid";
    await Promise.all([store.addGrant(grantFor(PAGE_ORIGIN, capture())), store.addGrant(grantFor(other, capture()))]);
    expect(await store.grants()).toHaveLength(2);
    await store.removeOrigin(PAGE_ORIGIN);
    expect((await store.grants()).map((grant) => grant.origin)).toEqual([other]);
  });

  it("filters corrupt stored entries", async () => {
    const store = new ConsentStore(memoryArea({ signInGrants: [{ origin: 1 }, "x"], declinedHosts: [1, "https://x.example.invalid/*"] }), () => Promise.resolve(true));
    expect(await store.grants()).toEqual([]);
    expect(await store.declined()).toEqual(["https://x.example.invalid/*"]);
  });
});
