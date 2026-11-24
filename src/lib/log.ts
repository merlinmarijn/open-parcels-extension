/**
 * Levelled logger. Never pass a captured sign-in address, a sign-in URL with its query, or anything
 * else that may carry a code or token; log ids, reasons and error messages only.
 */
export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

const PREFIX = "[open-parcels]";

function line(write: (...data: unknown[]) => void): (message: string, detail?: unknown) => void {
  return (message, detail) => {
    if (detail === undefined) write(`${PREFIX} ${message}`);
    else write(`${PREFIX} ${message}`, detail);
  };
}

export const log: Logger = {
  debug: line(console.debug),
  info: line(console.info),
  warn: line(console.warn),
  error: line(console.error),
};
