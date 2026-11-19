import { describe, expect, it } from "vitest";
import { OriginStore, STORAGE_KEY, normaliseOrigin, type KeyValueArea } from "../src/lib/origins.js";

function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

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
