/** Storage seams shared by every store, so logic can be tested against an in-memory area. */

export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Runs async jobs one after another. Read-modify-write sequences on a storage key go through one
 * of these so two quick updates cannot overwrite each other (EX-012).
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    // The chain must survive a failed job; the caller still sees the rejection through `next`.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
