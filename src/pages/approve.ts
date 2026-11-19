import browser from "webextension-polyfill";
import type { InternalMessage } from "../lib/runtime-messages.js";

const params = new URLSearchParams(location.search);
const approvalId = params.get("id") ?? "";
const origin = params.get("origin") ?? "";
const hosts = params.getAll("host");
const originKnown = params.get("mode") === "hosts";

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

byId("question").textContent = originKnown
  ? `${origin} wants to open a sign-in page. Allow the extension to watch it?`
  : `Allow ${origin} to use the open-parcels extension?`;

const hostList = byId("hosts");
if (hosts.length === 0) {
  byId("hosts-block").hidden = true;
} else {
  for (const host of hosts) {
    const item = document.createElement("li");
    item.textContent = host;
    hostList.append(item);
  }
}

async function answer(allowed: boolean): Promise<void> {
  const message: InternalMessage = { kind: "approval-result", approvalId, allowed };
  await browser.runtime.sendMessage(message);
  window.close();
}

byId("allow").addEventListener("click", () => {
  // permissions.request must run directly in the click handler (user gesture), before any await.
  const granted = hosts.length > 0 ? browser.permissions.request({ origins: hosts }) : Promise.resolve(true);
  // Without host access the extension still watches via webNavigation/tabs; capture may then miss
  // custom-scheme redirects, so a refused host permission is not treated as a refusal of the origin.
  void granted.catch(() => false).then(() => answer(true));
});

byId("deny").addEventListener("click", () => void answer(false));
