import { describe, expect, it } from "vitest";
import { SCRIPT_ID, bridgeMatches, syncBridge, type ContentScriptRegistration, type ScriptingApi } from "../src/lib/registration.js";

function fakeScripting(): ScriptingApi & { scripts: ContentScriptRegistration[] } {
  const api = {
    scripts: [] as ContentScriptRegistration[],
    getRegisteredContentScripts: () => Promise.resolve(api.scripts.map((script) => ({ id: script.id }))),
    unregisterContentScripts: ({ ids }: { ids: string[] }) => {
      api.scripts = api.scripts.filter((script) => !ids.includes(script.id));
      return Promise.resolve();
    },
    registerContentScripts: (scripts: ContentScriptRegistration[]) => {
      if (scripts.some((script) => api.scripts.some((existing) => existing.id === script.id))) {
        return Promise.reject(new Error("duplicate id"));
      }
      api.scripts.push(...scripts);
      return Promise.resolve();
    },
  };
  return api;
}

describe("bridge registration (EX-004)", () => {
  it("matches only enabled origins, top frame only", async () => {
    const api = fakeScripting();
    await syncBridge(api, ["https://parcels.example.invalid", "http://192.168.1.5:8080"]);
    await syncBridge(api, ["https://parcels.example.invalid", "http://192.168.1.5:8080"]);
    expect(api.scripts).toEqual([
      {
        id: SCRIPT_ID,
        matches: ["http://192.168.1.5/*", "https://parcels.example.invalid/*"],
        js: ["content.js"],
        runAt: "document_end",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  });

  it("unregisters when nothing is enabled", async () => {
    const api = fakeScripting();
    await syncBridge(api, ["https://parcels.example.invalid"]);
    await syncBridge(api, []);
    expect(api.scripts).toEqual([]);
  });

  it("dedupes origins that share scheme and host", () => {
    expect(bridgeMatches(["http://nas:8080", "http://nas:9090"])).toEqual(["http://nas/*"]);
  });
});
