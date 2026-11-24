/** Enabled open-parcels page origins (the pages the bridge content script is registered on). */
import { Serial, type KeyValueArea } from "./storage.js";

export const STORAGE_KEY = "approvedOrigins";

/** Normalises to `scheme://host[:port]`; null for anything that is not an http(s) origin. */
export function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    // Not a URL at all: by definition not an origin.
    return null;
  }
}

/** Whether `url` (a tab's current address) is a document of exactly `origin`. */
export function isSameOrigin(url: string | undefined, origin: string): boolean {
  return url !== undefined && normaliseOrigin(url) === origin;
}

/**
 * `secure`: https. `local-http`: plain http on loopback or a private-LAN address/name, allowed
 * with a warning (self-hosted installs). `refused`: plain http anywhere else, or not an origin.
 */
export type OriginTrust = "secure" | "local-http" | "refused";

const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home.arpa", ".internal"];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = -1, b = -1] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIpv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const bare = host.slice(1, -1).toLowerCase();
  return bare === "::1" || /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare);
}

function isLocalHostname(host: string): boolean {
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
  // A single-label name (http://nas:8080) only resolves on the local network.
  return !host.includes(".") && !host.includes(":") && /^[a-z0-9-]+$/.test(host);
}

export function originTrust(origin: string): OriginTrust {
  const normal = normaliseOrigin(origin);
  if (normal === null) return "refused";
  const url = new URL(normal);
  if (url.protocol === "https:") return "secure";
  return isLocalHostname(url.hostname) ? "local-http" : "refused";
}

/** Host-permission / content-script match pattern for an origin. Match patterns carry no port. */
export function originPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export class OriginStore {
  private readonly serial = new Serial();

  constructor(private readonly area: KeyValueArea) {}

  async list(): Promise<string[]> {
    const raw = (await this.area.get(STORAGE_KEY))[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === "string" && normaliseOrigin(item) === item).sort();
  }

  async isApproved(origin: string): Promise<boolean> {
    const normal = normaliseOrigin(origin);
    return normal !== null && (await this.list()).includes(normal);
  }

  approve(origin: string): Promise<void> {
    const normal = normaliseOrigin(origin);
    if (normal === null || originTrust(normal) === "refused") {
      return Promise.reject(new Error("not an https or local-network http origin"));
    }
    return this.serial.run(async () => {
      const current = await this.list();
      if (!current.includes(normal)) await this.area.set({ [STORAGE_KEY]: [...current, normal].sort() });
    });
  }

  revoke(origin: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.list();
      await this.area.set({ [STORAGE_KEY]: current.filter((item) => item !== origin) });
    });
  }
}
