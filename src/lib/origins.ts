/** Approved open-parcels page origins: the only thing this extension persists (rule 7). */

export const STORAGE_KEY = "approvedOrigins";

export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Normalises to `scheme://host[:port]`; null for anything that is not an http(s) origin. */
export function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export class OriginStore {
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

  async approve(origin: string): Promise<void> {
    const normal = normaliseOrigin(origin);
    if (normal === null) throw new Error("not an http(s) origin");
    const current = await this.list();
    if (!current.includes(normal)) await this.area.set({ [STORAGE_KEY]: [...current, normal].sort() });
  }

  async revoke(origin: string): Promise<void> {
    const current = await this.list();
    await this.area.set({ [STORAGE_KEY]: current.filter((item) => item !== origin) });
  }
}
