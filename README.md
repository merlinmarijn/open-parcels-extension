<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-dark.png">
    <img alt="Open Parcels" src="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-light.png" width="640">
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
  passwords; it only looks at the **addresses** loaded in the one sign-in tab it opened.
- The only thing stored is the list of open-parcels addresses (origins) you approved. Revoke them
  in the options page. Captured sign-in addresses live in memory only until they are handed over.
  While a sign-in runs, its bookkeeping (tab id, request id, prefix, deadline; never the captured
  address) is mirrored to `storage.session`, which is memory-only, so a Chromium service-worker
  restart does not lose the sign-in.
- No tracking, no analytics, no network requests of its own.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Approved origins (`storage.local`), running sign-ins (`storage.session`, memory only). |
| `tabs` | Open/close the sign-in window and read the address it navigates to (`tabs.onUpdated`). |
| `webNavigation` | See main-frame navigations and failed navigations (custom schemes) in the sign-in tab. |
| `webRequest` | See redirects (`onBeforeRedirect` → `redirectUrl`), the only place a refused `dhllogin://` redirect is reliably visible; detect the POST that triggers the resume rule. Observing only, no blocking. |
| optional host permissions (`https://*/*`, `http://*/*`) | `webRequest` only reports requests to hosts the extension may access. Nothing is granted at install; when a capture starts, the approval window asks for just the carrier's sign-in host(s) (`permissions.request`, from the Allow click). Without it the extension still watches via `webNavigation`/`tabs`, but may miss custom-scheme redirects. |
| content script on `<all_urls>` | The open-parcels web UI can be self-hosted at any address. The script does nothing unless the page has `<meta name="open-parcels" content="web-ui">`; then it only relays `window.postMessage` messages. |

Firefox note: in MV3 Firefox treats content-script matches as host permissions the user may
toggle in `about:addons`; if site access is withheld, the open-parcels page won't detect the extension.

## Build

```sh
npm install
npm run build        # dist/firefox and dist/chromium (icons rendered from assets/logo.svg)
npm test             # vitest, pure logic
npm run lint         # eslint + tsc --noEmit
npm run lint:firefox # web-ext lint on dist/firefox
npm run check        # all of the above
```

## Load unpacked

- **Firefox / LibreWolf:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
  pick `dist/firefox/manifest.json`. (Temporary add-ons are removed on restart.)
- **Chrome / Edge / Brave:** `chrome://extensions` (`edge://`, `brave://`) → enable *Developer
  mode* → *Load unpacked* → pick `dist/chromium`.

## How a capture runs

1. The open-parcels page sends `capture` with the sign-in `url`, a `redirectPrefix` and an
   optional `resumeUrl`.
2. First time for that page origin (or when the carrier host isn't granted yet) a small window
   asks *Allow &lt;origin&gt; to use the open-parcels extension?* Deny → `cancelled: denied`.
3. The sign-in opens in its own popup window. The first address in that tab that starts with
   `redirectPrefix` closes the window and is sent back as `captured`.
4. Closing the window → `cancelled: closed`; after 15 minutes → `cancelled: timeout`.

## License

Released into the public domain under [the Unlicense](LICENSE).
