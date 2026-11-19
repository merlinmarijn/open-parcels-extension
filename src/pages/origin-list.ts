import browser from "webextension-polyfill";
import { OriginStore } from "../lib/origins.js";

export const store = new OriginStore(browser.storage.local);

/** Renders the approved origins into `list`, optionally with a revoke button per entry. */
export async function renderOrigins(list: HTMLElement, revocable: boolean): Promise<void> {
  const approved = await store.list();
  list.replaceChildren();
  if (approved.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No approved open-parcels addresses yet.";
    list.append(empty);
    return;
  }
  for (const origin of approved) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = origin;
    item.append(label);
    if (revocable) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Revoke";
      button.addEventListener("click", () => {
        void store.revoke(origin).then(() => renderOrigins(list, revocable));
      });
      item.append(button);
    }
    list.append(item);
  }
}
