/**
 * The bridge content script is registered dynamically, only for enabled origins (EX-004), instead
 * of a static `<all_urls>` entry: no "all your data on all websites" warning, and other sites can
 * neither detect the extension nor reach the background.
 */
import { originPattern } from "./origins.js";

export const SCRIPT_ID = "open-parcels-bridge";

export interface ContentScriptRegistration {
  id: string;
  matches: string[];
  js: string[];
  runAt: "document_end";
  allFrames: false;
  persistAcrossSessions: true;
}

export interface ScriptingApi {
  getRegisteredContentScripts(): Promise<{ id: string }[]>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  registerContentScripts(scripts: ContentScriptRegistration[]): Promise<void>;
}

/** Match patterns for the enabled origins (one per scheme+host; ports are checked in the background). */
export function bridgeMatches(origins: string[]): string[] {
  return [...new Set(origins.map(originPattern))].sort();
}

/** Makes the registered bridge match exactly `origins` (none: unregistered). */
export async function syncBridge(api: ScriptingApi, origins: string[]): Promise<void> {
  const registered = await api.getRegisteredContentScripts();
  if (registered.some((script) => script.id === SCRIPT_ID)) await api.unregisterContentScripts({ ids: [SCRIPT_ID] });
  const matches = bridgeMatches(origins);
  if (matches.length === 0) return;
  await api.registerContentScripts([
    { id: SCRIPT_ID, matches, js: ["content.js"], runAt: "document_end", allFrames: false, persistAcrossSessions: true },
  ]);
}
