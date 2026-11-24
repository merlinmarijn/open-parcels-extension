import { originTrust } from "../lib/origins.js";

export interface ListEntry {
  label: string;
  /** Called by the entry's button; omitted: no button. */
  action?: { text: string; run: () => Promise<void> };
}

/** Labels an origin, marking plain-http ones (EX-015). */
export function originLabel(origin: string): string {
  return originTrust(origin) === "secure" ? origin : `${origin} (plain http)`;
}

/** Renders `entries` into `list`; `onError` receives a failed action. */
export function renderList(list: HTMLElement, entries: ListEntry[], empty: string, onError: (error: unknown) => void): void {
  list.replaceChildren();
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = empty;
    list.append(item);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = entry.label;
    item.append(label);
    const action = entry.action;
    if (action !== undefined) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.text;
      button.addEventListener("click", () => {
        action.run().catch(onError);
      });
      item.append(button);
    }
    list.append(item);
  }
}
