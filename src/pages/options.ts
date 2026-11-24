import browser from "webextension-polyfill";
import { ConsentStore } from "../lib/consent.js";
import { OriginStore } from "../lib/origins.js";
import type { InternalMessage } from "../lib/runtime-messages.js";
import { byId, showError } from "./dom.js";
import { originLabel, renderList } from "./origin-list.js";

const origins = new OriginStore(browser.storage.local);
const consent = new ConsentStore(browser.storage.local, (pattern) => browser.permissions.contains({ origins: [pattern] }));
const onError = showError(byId("status"), "That did not work");

async function render(): Promise<void> {
  const enabled = await origins.list();
  renderList(
    byId("origins"),
    enabled.map((origin) => ({
      label: originLabel(origin),
      action: {
        text: "Revoke",
        run: async () => {
          const message: InternalMessage = { kind: "revoke-origin", origin };
          await browser.runtime.sendMessage(message);
        },
      },
    })),
    "None yet. Open your open-parcels page and choose \"Enable on this site\" in the extension's menu.",
    onError,
  );
  renderList(
    byId("grants"),
    (await consent.grants()).map((grant) => ({
      label: `${grant.origin} → ${grant.signInHost} → ${grant.target}`,
      action: { text: "Remove", run: () => consent.removeGrant(grant).then(render) },
    })),
    "None.",
    onError,
  );
  renderList(
    byId("hosts"),
    ((await browser.permissions.getAll()).origins ?? []).sort().map((pattern) => ({
      label: pattern,
      action: { text: "Remove", run: () => browser.permissions.remove({ origins: [pattern] }).then(render) },
    })),
    "None.",
    onError,
  );
  renderList(
    byId("declined"),
    (await consent.declined()).map((pattern) => ({
      label: pattern,
      action: { text: "Forget", run: () => consent.forgetDeclined(pattern).then(render) },
    })),
    "None.",
    onError,
  );
}

// Revocation runs in the background; follow the stores instead of guessing when it finished.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") render().catch(onError);
});
browser.permissions.onRemoved.addListener(() => {
  render().catch(onError);
});
render().catch(onError);
