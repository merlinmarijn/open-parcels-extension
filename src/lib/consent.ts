/**
 * Per-request consent (EX-003, EX-014). An enabled page origin may ask for a capture; the user then
 * approves *that* sign-in once, or always for this origin + sign-in host + redirect target.
 * Host access the user refused is remembered so the prompt does not come back for it.
 */
import { hostPermissionOrigins, type CaptureFromPage } from "./protocol.js";
import { Serial, isRecord, type KeyValueArea } from "./storage.js";

export const GRANTS_KEY = "signInGrants";
export const DECLINED_KEY = "declinedHosts";

/** What "always allow" is bound to. */
export interface Grant {
  origin: string;
  signInHost: string;
  target: string;
}

export type Decision = "once" | "always" | "deny";

export function isDecision(value: unknown): value is Decision {
  return value === "once" || value === "always" || value === "deny";
}

/** Host of the sign-in page (already validated as https by validateCapture). */
export function signInHost(url: string): string {
  return new URL(url).host;
}

/**
 * Scheme and host of the redirect prefix, which is what the page will receive:
 * `https://shop.example/callback?x` → `https://shop.example`, `dhllogin://login?x` → `dhllogin://login`.
 */
export function redirectTarget(prefix: string): string {
  try {
    const url = new URL(prefix);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    return url.host.length > 0 ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    // validateCapture already accepted it as a prefix with a scheme; show the scheme only.
    return prefix.slice(0, prefix.indexOf(":") + 1);
  }
}

export function grantFor(origin: string, capture: CaptureFromPage): Grant {
  return { origin, signInHost: signInHost(capture.url), target: redirectTarget(capture.redirectPrefix) };
}

function isGrant(value: unknown): value is Grant {
  return (
    isRecord(value) &&
    typeof value.origin === "string" &&
    typeof value.signInHost === "string" &&
    typeof value.target === "string"
  );
}

function sameGrant(a: Grant, b: Grant): boolean {
  return a.origin === b.origin && a.signInHost === b.signInHost && a.target === b.target;
}

export interface ConsentCheck {
  /** Whether the approval window must be shown. */
  ask: boolean;
  /** Host-permission patterns to request from that window (not held, not declined before). */
  hosts: string[];
}

export class ConsentStore {
  private readonly serial = new Serial();

  constructor(
    private readonly area: KeyValueArea,
    private readonly hasHostAccess: (pattern: string) => Promise<boolean>,
  ) {}

  async grants(): Promise<Grant[]> {
    const raw = (await this.area.get(GRANTS_KEY))[GRANTS_KEY];
    return Array.isArray(raw) ? raw.filter(isGrant) : [];
  }

  async declined(): Promise<string[]> {
    const raw = (await this.area.get(DECLINED_KEY))[DECLINED_KEY];
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  }

  async check(origin: string, capture: CaptureFromPage): Promise<ConsentCheck> {
    const wanted = grantFor(origin, capture);
    const granted = (await this.grants()).some((grant) => sameGrant(grant, wanted));
    const declined = new Set(await this.declined());
    const hosts: string[] = [];
    for (const pattern of hostPermissionOrigins(capture)) {
      if (!declined.has(pattern) && !(await this.hasHostAccess(pattern))) hosts.push(pattern);
    }
    return { ask: !granted || hosts.length > 0, hosts };
  }

  /** Records the outcome of one approval window. */
  async remember(grant: Grant, decision: Decision, requestedHosts: string[], hostsGranted: boolean): Promise<void> {
    if (decision === "always") await this.addGrant(grant);
    if (decision !== "deny" && !hostsGranted && requestedHosts.length > 0) await this.decline(requestedHosts);
  }

  addGrant(grant: Grant): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.grants();
      if (!current.some((item) => sameGrant(item, grant))) await this.area.set({ [GRANTS_KEY]: [...current, grant] });
    });
  }

  removeGrant(grant: Grant): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.grants();
      await this.area.set({ [GRANTS_KEY]: current.filter((item) => !sameGrant(item, grant)) });
    });
  }

  removeOrigin(origin: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.grants();
      await this.area.set({ [GRANTS_KEY]: current.filter((item) => item.origin !== origin) });
    });
  }

  decline(patterns: string[]): Promise<void> {
    return this.serial.run(async () => {
      const current = new Set(await this.declined());
      for (const pattern of patterns) current.add(pattern);
      await this.area.set({ [DECLINED_KEY]: [...current].sort() });
    });
  }

  forgetDeclined(pattern: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.declined();
      await this.area.set({ [DECLINED_KEY]: current.filter((item) => item !== pattern) });
    });
  }
}
