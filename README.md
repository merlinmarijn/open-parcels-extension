<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-parcels/open-parcels/main/docs/branding/banner-on-dark.png">
    <img alt="Open Parcels" src="https://raw.githubusercontent.com/open-parcels/open-parcels/main/docs/branding/banner-on-light.png" width="640">
  </picture>
</p>
<p align="center">
  <a href="https://github.com/open-parcels/open-parcels-extension/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/open-parcels/open-parcels-extension?include_prereleases&sort=semver"></a>
  <a href="https://github.com/open-parcels/open-parcels-extension/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/open-parcels/open-parcels-extension/total"></a>
  <a href="https://github.com/open-parcels/open-parcels-extension/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/open-parcels/open-parcels-extension?style=flat"></a>
  <a href="https://github.com/open-parcels/open-parcels-extension/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/open-parcels/open-parcels-extension"></a>
</p>

# open-parcels companion extension

Some parcel carriers (for example DHL Germany) only offer a phone-app sign-in. Its last step
redirects to an address a browser refuses to open (`dhllogin://…?code=…`), or to a callback page
whose address you would otherwise copy by hand. This extension catches that address in the sign-in
window and hands it to the [open-parcels](https://github.com/open-parcels) web UI, which submits it
just like a pasted address. The server checks `state`, so a stray code is refused.

Works in Firefox (incl. LibreWolf, 128+) and Chromium browsers (Chrome, Edge, Brave; 116+),
Manifest V3, one codebase.

Protocol: [`docs/extension-protocol.md`](https://github.com/open-parcels/open-parcels/blob/main/docs/extension-protocol.md)
in the open-parcels repository.

## Privacy

- You sign in on the carrier's own page. The extension never reads page content, forms or
  passwords; it only acts on the **addresses** loaded in the one sign-in tab it opened (its
  webRequest listeners see main-frame requests to hosts you granted and ignore every other tab).
- Stored in `storage.local`: the open-parcels addresses (origins) you enabled, the sign-ins you
  chose to *always allow* (page origin + sign-in host + redirect target), and the sign-in hosts
  whose site access you refused (so you are not asked again). All of it is listed and removable
  in the options page.
- While a sign-in runs, its bookkeeping (tab and window ids, request id, the page's request,
  deadline) lives in `storage.session`, which is memory-only, so a Chromium service-worker restart
  does not lose it. The captured address itself is never stored; it is handed over and forgotten.
- No tracking, no analytics, no network requests of its own.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | See Privacy. |
| `tabs` | Open/close the sign-in window, read the address it navigates to (`tabs.onUpdated`), and check that the open-parcels tab still shows the address that asked before handing the result over. |
| `webNavigation` | See main-frame navigations and failed navigations (custom schemes) in the sign-in tab; notice when the open-parcels tab navigates away (its request is then dropped). |
| `webRequest` | See main-frame redirects (`onBeforeRedirect` → `redirectUrl`), the only place a refused `dhllogin://` redirect is reliably visible; detect the POST that triggers the resume rule. Observing only, no blocking. |
| `alarms` | Sign-in and approval deadlines that survive a stopped service worker. |
| `scripting` | Register the small page bridge for the addresses you enabled, and only those. |
| optional host permissions (`https://*/*`, `http://*/*`) | Nothing is granted at install. Enabling an open-parcels address asks for that address only; approving a sign-in asks for the carrier's sign-in host(s), so `webRequest` can see its redirects. Refusing the carrier hosts still works through `webNavigation`/`tabs`, but may miss custom-scheme redirects. |

There is no content script on all sites: other pages cannot reach or even detect the extension.

## Enabling it for your open-parcels server

1. Open your open-parcels web UI, click the extension's toolbar button and choose **Enable on
   this site…**, then allow the browser's site-access prompt. The page reloads.
2. Only `https` addresses, or plain `http` on your own network (localhost, private IP ranges,
   `.local`/`.lan`/`.home.arpa`/`.internal` and single-label names such as `http://nas:8080`),
   can be enabled; plain http gets a warning.

**Home Assistant:** the HA app's ingress panel shows the web UI in a frame on the Home
Assistant address, which every other HA app and panel shares. The extension deliberately only
works in top-level pages of an enabled address, so it does not work inside the ingress panel.
Open the web UI in its own tab on its own address instead (for example its direct port or
reverse-proxy address) and enable that.

## Build

```sh
npm ci
npm run build        # dist/firefox and dist/chromium (icons rendered from assets/logo.svg)
npm test             # vitest, pure logic
npm run lint         # eslint + tsc --noEmit
npm run lint:firefox # web-ext lint on dist/firefox
npm run check        # all of the above
npm run package      # check, then release/: a zip per browser, the sources and SHA256SUMS
```

Node 20 or newer; the build is unminified for store review.

## Releases

`npm run package` builds from a clean checkout of a commit (it refuses uncommitted changes) and
writes to `release/`:

| File | For |
| :--- | :--- |
| `open-parcels-firefox-<version>.zip` | addons.mozilla.org (AMO) |
| `open-parcels-chromium-<version>.zip` | the Chrome Web Store (also Edge Add-ons) |
| `open-parcels-extension-source-<version>.zip` | AMO's source review (every tracked file) |
| `SHA256SUMS` | the three zips' SHA-256 |

The zips are **reproducible**: entries sorted, every one stamped with the commit's time (or
`SOURCE_DATE_EPOCH`), fixed permissions and compression, and an unminified esbuild bundle from the
locked dependencies. Anyone can check out the tag, run `npm ci && npm run package` and compare
with `sha256sum -c release/SHA256SUMS`. The source zip is what a reviewer builds from with the same
two commands.

### Release steps

1. Bump `version` in `package.json` (the manifests take it from there), commit, tag `v<version>`.
2. `npm ci && npm run package`; keep `release/SHA256SUMS` with the release notes.
3. **Firefox (AMO, signed by Mozilla):** create API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/> and pass them only through the
   environment, never in a file of this repository:

   ```sh
   WEB_EXT_API_KEY=user:12345:67 WEB_EXT_API_SECRET=… npm run sign:firefox
   ```

   This runs `web-ext sign --channel listed` on `dist/firefox`, uploads the source zip for review
   and saves the signed `.xpi` under `release/signed/` once Mozilla has signed it (a listed version
   can wait for review; `web-ext` then says so and the `.xpi` appears in the AMO developer hub).
   The add-on id is `extension@open-parcels.github.io`; the first upload creates the listing, which
   needs the description, the privacy policy (see *Privacy*) and the
   `data_collection_permissions` the manifest already declares.
4. **Chrome Web Store:** in the developer dashboard
   (<https://chrome.google.com/webstore/devconsole>), *Add new item* (first release) or the item's
   *Package → Upload new package*, and upload `open-parcels-chromium-<version>.zip`. Fill in the
   privacy practices (single purpose, permission justifications from *Permissions*, no data
   collected) and submit for review. The store signs the package itself; no key is kept here.
5. **Edge Add-ons** (optional): upload the same Chromium zip at
   <https://partner.microsoft.com/dashboard/microsoftedge/>.

Signing keys and store credentials stay with the owner; `release/` and `*.pem` are ignored by git.

## Load unpacked

- **Firefox / LibreWolf:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
  pick `dist/firefox/manifest.json`. (Temporary add-ons are removed on restart.)
- **Chrome / Edge / Brave:** `chrome://extensions` (`edge://`, `brave://`) → enable *Developer
  mode* → *Load unpacked* → pick `dist/chromium`.

## How a capture runs

1. On an enabled address the open-parcels page sends `capture` with the sign-in `url`, a
   `redirectPrefix` and an optional `resumeUrl`. Only the active tab can start one; one request
   per tab and one open approval per address at a time (others get `cancelled: busy`).
2. Unless you chose *Always allow* for this address, sign-in host and redirect target, a small
   window shows the page, the sign-in host it opens and the address it will receive, with
   **Deny**, **Allow once** and **Always allow**. Deny → `cancelled: denied`, and further
   requests from that address are refused without asking for 10 minutes. Closing the window
   counts as Deny; after 5 minutes → `cancelled: timeout`.
3. The sign-in opens in its own popup window. The first address in that tab that starts with
   `redirectPrefix` closes the window and is sent back as `captured`, but only if the
   open-parcels tab still shows the address that asked; otherwise it is dropped.
4. Closing the window → `cancelled: closed`; after 15 minutes → `cancelled: timeout`; a window
   that cannot be opened → `cancelled: error`. Reloading or leaving the open-parcels page, or
   revoking the address, ends the sign-in silently.

## License

Released into the public domain under [the Unlicense](LICENSE).
