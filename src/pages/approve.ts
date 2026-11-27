import browser from "webextension-polyfill";
import type { Decision } from "../lib/consent.js";
import { originTrust } from "../lib/origins.js";
import type { InternalMessage } from "../lib/runtime-messages.js";
import { byId, showError } from "./dom.js";

const params = new URLSearchParams(location.search);
const approvalId = params.get("id") ?? "";
const origin = params.get("origin") ?? "";
const signInHost = params.get("signInHost") ?? "";
const target = params.get("target") ?? "";
const hosts = params.getAll("host");
const cookieCapture = params.get("cookieCapture") === "true";

byId("question").textContent = `${origin} wants to open a carrier sign-in and receive the address it ends on.`;
if (cookieCapture) {
  byId("question").textContent = `${origin} wants your Bol session cookies to read your purchases and shipment tracking. These cookies grant access to your Bol account. Allow only a dashboard you trust.`;
  byId("always").hidden = true;
  byId("privacy-note").textContent = "The extension does not read your password or forms. It reads the Cookie request header, including HttpOnly session cookies, only in the Bol sign-in tab it opens, then sends that header to this dashboard.";
  byId("host-note").textContent = "Bol site access is required to capture the Cookie header. Refusing it stops this sign-in.";
}
byId("origin").textContent = origin;
byId("sign-in").textContent = `https://${signInHost}`;
byId("target").textContent = `${target}… (the final sign-in address)`;
if (cookieCapture) byId("target").textContent = "Bol session Cookie header (including HttpOnly cookies)";
byId("insecure").hidden = originTrust(origin) === "secure";
byId("always-note").textContent = `"Always allow" skips this question for ${origin} with ${signInHost} from now on. Manage it in the extension's options.`;
if (cookieCapture) byId("always-note").textContent = "Approval is required each time. Cookies are sent only to this dashboard and are never saved by the extension.";

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

async function answer(decision: Decision, hostsGranted: boolean): Promise<void> {
  const message: InternalMessage = { kind: "approval-result", approvalId, decision, hostsGranted };
  await browser.runtime.sendMessage(message);
  window.close();
}

function allow(decision: Decision): void {
  // permissions.request must run directly in the click handler (user gesture), before any await.
  const granted = hosts.length > 0 ? browser.permissions.request({ origins: hosts }) : Promise.resolve(true);
  granted
    .catch((error: unknown) => {
      showError(byId("always-note"), "Requesting host access failed")(error);
      return false;
    })
    .then((ok) => answer(decision, ok))
    .catch(showError(byId("always-note"), "Could not reach the extension"));
}

byId("once").addEventListener("click", () => {
  allow("once");
});
byId("always").addEventListener("click", () => {
  allow("always");
});
byId("deny").addEventListener("click", () => {
  answer("deny", false).catch(showError(byId("always-note"), "Could not reach the extension"));
});
