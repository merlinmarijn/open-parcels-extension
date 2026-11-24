import browser from "webextension-polyfill";
import { normaliseOrigin, originPattern, originTrust } from "../lib/origins.js";
import type { InternalMessage } from "../lib/runtime-messages.js";
import { byId, showError } from "./dom.js";

const params = new URLSearchParams(location.search);
const origin = normaliseOrigin(params.get("origin") ?? "");
const rawTab = Number(params.get("tab"));
const tabId = Number.isInteger(rawTab) && rawTab >= 0 ? rawTab : null;
const status = byId("status");
const enable = byId("enable");

if (origin === null || originTrust(origin) === "refused") {
  byId("question").textContent = "This address cannot be enabled: only https, or plain http on your own local network (localhost, private addresses, .local/.lan names).";
  enable.hidden = true;
} else {
  byId("question").textContent = `Enable the open-parcels extension on ${origin}?`;
  byId("insecure").hidden = originTrust(origin) === "secure";
  enable.addEventListener("click", () => {
    // permissions.request must run directly in the click handler (user gesture).
    browser.permissions
      .request({ origins: [originPattern(origin)] })
      .then(async (granted) => {
        if (!granted) {
          status.textContent = "Site access was not granted, so the extension stays off here.";
          return;
        }
        const message: InternalMessage = { kind: "enable-origin", origin, tabId };
        await browser.runtime.sendMessage(message);
        window.close();
      })
      .catch(showError(status, "Enabling failed"));
  });
}

byId("cancel").addEventListener("click", () => {
  window.close();
});
