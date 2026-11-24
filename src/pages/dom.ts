import { log } from "../lib/log.js";

export function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

/** Shows a failure on the page as well as in the log, instead of leaving a dead button. */
export function showError(target: HTMLElement, what: string): (error: unknown) => void {
  return (error) => {
    log.error(what, error);
    target.textContent = `${what}. See the extension's console for details.`;
  };
}
