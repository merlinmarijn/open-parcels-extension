import browser from "webextension-polyfill";
import { renderOrigins } from "./origin-list.js";

const version = document.getElementById("version");
if (version !== null) version.textContent = `v${browser.runtime.getManifest().version}`;
const list = document.getElementById("origins");
if (list !== null) void renderOrigins(list, false);
document.getElementById("options")?.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => {
    window.close();
  });
});
