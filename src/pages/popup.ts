import browser from "webextension-polyfill";
import { OriginStore, normaliseOrigin, originTrust } from "../lib/origins.js";
import { byId, showError } from "./dom.js";
import { originLabel, renderList } from "./origin-list.js";

const origins = new OriginStore(browser.storage.local);
const onError = showError(byId("status"), "That did not work");

async function render(): Promise<void> {
  byId("version").textContent = `v${browser.runtime.getManifest().version}`;
  const enabled = await origins.list();
  renderList(byId("origins"), enabled.map((origin) => ({ label: originLabel(origin) })), "None yet.", onError);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const origin = normaliseOrigin(tab?.url ?? "");
  const here = byId("here");
  if (tab?.id === undefined || origin === null) {
    here.textContent = "Open your open-parcels page to enable the extension there.";
    return;
  }
  if (enabled.includes(origin)) {
    here.textContent = `Enabled on ${origin}.`;
    return;
  }
  if (originTrust(origin) === "refused") {
    here.textContent = `${origin} uses plain http outside your local network; the extension cannot be enabled there.`;
    return;
  }
  here.textContent = `Not enabled on ${origin}.`;
  const button = byId("enable");
  button.hidden = false;
  const query = new URLSearchParams({ origin, tab: String(tab.id) });
  button.addEventListener("click", () => {
    // The browser's site-access prompt would close this popup, so it runs in its own window.
    browser.windows
      .create({ url: browser.runtime.getURL(`enable.html?${query.toString()}`), type: "popup", width: 460, height: 360 })
      .then(() => {
        window.close();
      })
      .catch(onError);
  });
}

byId("options").addEventListener("click", () => {
  browser.runtime
    .openOptionsPage()
    .then(() => {
      window.close();
    })
    .catch(onError);
});
render().catch(onError);
