import { describe, expect, it } from "vitest";
import { OriginStore, STORAGE_KEY, isSameOrigin, normaliseOrigin, originPattern, originTrust } from "../src/lib/origins.js";
import { memoryArea } from "./fakes.js";

describe("normaliseOrigin", () => {
  it("reduces to scheme://host[:port]", () => {
    expect(normaliseOrigin("https://parcels.example.invalid/app?x=1")).toBe("https://parcels.example.invalid");
    expect(normaliseOrigin("http://parcels.example.invalid:8080/")).toBe("http://parcels.example.invalid:8080");
  });
  it("rejects non-http origins", () => {
    expect(normaliseOrigin("file:///tmp/x")).toBeNull();
    expect(normaliseOrigin("not a url")).toBeNull();
  });
});

describe("OriginStore", () => {
  it("starts empty and approves origins once", async () => {
    const area = memoryArea();
    const store = new OriginStore(area);
    expect(await store.list()).toEqual([]);
    await store.approve("https://b.example.invalid/x");
    await store.approve("https://a.example.invalid");
    await store.approve("https://b.example.invalid/");
    expect(await store.list()).toEqual(["https://a.example.invalid", "https://b.example.invalid"]);
    expect(await store.isApproved("https://a.example.invalid/page")).toBe(true);
    expect(await store.isApproved("https://c.example.invalid")).toBe(false);
  });

  it("revokes", async () => {
    const store = new OriginStore(memoryArea({ [STORAGE_KEY]: ["https://a.example.invalid"] }));
    await store.revoke("https://a.example.invalid");
    expect(await store.isApproved("https://a.example.invalid")).toBe(false);
  });

  it("ignores corrupt storage", async () => {
    const store = new OriginStore(memoryArea({ [STORAGE_KEY]: ["https://ok.example.invalid", 5, "junk", "https://x.example.invalid/path"] }));
    expect(await store.list()).toEqual(["https://ok.example.invalid"]);
    expect(await new OriginStore(memoryArea({ [STORAGE_KEY]: "nope" })).list()).toEqual([]);
  });

  it("refuses non-http origins", async () => {
    await expect(new OriginStore(memoryArea()).approve("file:///x")).rejects.toThrow();
  });
});

describe("isSameOrigin (EX-001: results only go to the origin that asked)", () => {
  const origin = "https://parcels.example.invalid";
  it("accepts any address of the requesting origin", () => {
    expect(isSameOrigin("https://parcels.example.invalid/sources/dhl", origin)).toBe(true);
  });
  it("refuses another origin now loaded in the same tab", () => {
    expect(isSameOrigin("https://evil.example.invalid/", origin)).toBe(false);
    expect(isSameOrigin("http://parcels.example.invalid/", origin)).toBe(false);
    expect(isSameOrigin("https://parcels.example.invalid:8443/", origin)).toBe(false);
  });
  it("refuses unknown or non-http addresses", () => {
    expect(isSameOrigin(undefined, origin)).toBe(false);
    expect(isSameOrigin("about:blank", origin)).toBe(false);
  });
});

describe("originTrust (EX-015)", () => {
  it("https is secure", () => {
    expect(originTrust("https://parcels.example.invalid")).toBe("secure");
  });
  it("plain http only on loopback and the local network", () => {
    for (const origin of [
      "http://localhost:8080",
      "http://127.0.0.1",
      "http://192.168.2.11:3000",
      "http://10.0.0.5",
      "http://172.20.1.1",
      "http://[::1]:8080",
      "http://[fd00::1]",
      "http://nas:8080",
      "http://parcels.local",
      "http://parcels.home.arpa",
    ]) {
      expect(originTrust(origin), origin).toBe("local-http");
    }
  });
  it("refuses public plain http and non-origins", () => {
    for (const origin of ["http://parcels.example.invalid", "http://8.8.8.8", "http://172.32.0.1", "ftp://nas", "nope"]) {
      expect(originTrust(origin), origin).toBe("refused");
    }
  });
});

describe("originPattern", () => {
  it("drops the port, which match patterns cannot carry", () => {
    expect(originPattern("http://192.168.2.11:3000")).toBe("http://192.168.2.11/*");
  });
});

describe("OriginStore.approve", () => {
  it("refuses public plain-http origins", async () => {
    await expect(new OriginStore(memoryArea()).approve("http://parcels.example.invalid")).rejects.toThrow();
  });
  it("does not lose concurrent approvals (EX-012)", async () => {
    const store = new OriginStore(memoryArea());
    await Promise.all([store.approve("https://a.example.invalid"), store.approve("https://b.example.invalid")]);
    expect(await store.list()).toEqual(["https://a.example.invalid", "https://b.example.invalid"]);
  });
});
