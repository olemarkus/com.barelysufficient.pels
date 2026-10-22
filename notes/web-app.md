# Standalone web app

*(shipped: client, launcher, `ui_version`, publishing at `/app/`)*

The web app runs the settings UI outside Homey: from a browser or an installed
PWA, against one or more Homeys. It is the same settings bundle as the Homey
settings page, in a second host. Code: `packages/settings-ui/src/remote/`,
built by `npm --workspace @pels/settings-ui run build:remote` into
`packages/settings-ui/dist-remote/`, which never ships inside the Homey app.

## Access

Each Homey is reached with an API key the owner creates in the Homey web app
(Settings, API Keys) with permission to control apps (`homey.app.control`),
sent as `Authorization: Bearer` to one of the Homey's addresses (see
Addresses). Verified in the supervisor and live on the test Homey:

- PELS's non-public routes require exactly `homey.app.control`; Homey's
  app-settings endpoints accept it too, so `Homey.get`/`set`/`api` map one to
  one onto REST.
- The scope is not per app: the key can read and change every app's settings.
  The add form says so.
- Only the owner can create API keys; users and guests hold
  `homey.app.readonly`, which cannot call PELS routes.
- Self-registered OAuth clients only get read-only app scopes, so a "log in
  with Homey" flow cannot replace the key.
- Every address answers CORS preflights for `authorization` and
  `content-type` with `access-control-allow-origin: *`.

Realtime uses Homey's socket.io v2 protocol (`handshakeClient` with the key,
then `subscribe` to `homey:app:<id>` on the returned namespace). It carries the
same events the WebView delivers, `settings.set`/`settings.unset` included. It
works on the home-network address and on the Homey's own cloud host; the relay
socket works on a Homey Pro but answers `homey_offline` on the self-hosted test
Homey.

Homey only sends settings events while the socket is up, and the settings UI
caches settings until one arrives. After a reconnect the build compares all
PELS settings with the copy taken while live and announces each difference as
the event Homey would have sent; a key announced while live is announced again,
so a value changed and changed back across the drop is not missed. Runtime read
models catch up on their own refresh timers or with the next event.

## Addresses

A Homey has three addresses the web app can use, in this order of preference:

1. **Home network**, `https://<a-b-c-d>.homey.homeylocal.com` (`:4860` on a
   Self-Hosted Server). Quickest, and no cloud limit applies. `ui_version`
   reports Homey's own `ip:port` (`ManagerCloud.getLocalAddress`, which gives
   the HTTP port); the web app keeps it as the HTTPS address the Athom account
   lists for the same Homey (HTTP 80 → HTTPS 443, Self-Hosted Server 4859 →
   4860, both verified against the account's `localUrlSecure`).
2. **The Homey's own cloud host**, `<homeyId>.homey.<cluster>.homeypro.net`
   (`.homeyshs.net` for a Self-Hosted Server). Homey's web app serves the
   settings page and all its calls from it. The cluster cannot be derived from
   the id, and the Athom account API that lists it needs an Athom login, so the
   web app learns it from the PELS settings page (below) or a pasted address.
3. **The relay**, `<homeyId>.connect.athom.com`, the only address a bare id
   gives. It limits each Homey: in a burst of 200 calls it let 37 through and
   answered the rest with 429 for about a minute, unauthenticated pings
   included, while the cloud host answered all 200 (test Homey, 2026-10-22).

An API key goes wherever its address leads, so the web app accepts, keeps and
uses only these forms (`remote/homeyAddress.ts`): an HTTPS Athom cloud host
named for that Homey, or `https://<private IPv4>.homey.homeylocal.com` on port
443 or 4860. Anything else pasted is refused, and anything else found in
storage is dropped.

Each start pings the home-network address (`/api/manager/system/ping`, 1.5 s)
and uses it only when it answers with this Homey's id (Homey exposes
`X-Homey-ID` there; the cloud does not); otherwise calls go to the cloud
address. The launcher hands the address it checked to the build it opens
through this tab's session storage, taken once and only while the stored
record still holds that address, so opening a Homey probes once and a link
cannot skip the check.

A call on the home network that gets no answer within 10 s, or cannot reach
Homey at all, as when a phone leaves home with the page open, moves the page
to the cloud address and the socket follows. Reads under way are sent again
from the cloud; a write is not, since it may have reached Homey, and fails as
it would in the WebView. A 429 is waited out and the call sent again (about 2,
5, 10, 20 and 30 s, spread so a page's calls do not return together), while
the page says Homey's cloud connection is busy.

## Adding Homeys to a phone

API keys are made in the Homey web app, whose API Keys page cannot be used at
phone width (the settings menu covers it; Chrome's Desktop site option works).
So the owner adds Homeys on a computer, and the launcher there shows a code
for the phone's camera (Add to your phone). The code is a link to the launcher
with every listed Homey after `#pair=`: name, key, and cloud address, or just
the id when that is the relay (`remote/phonePairing.ts`). The fragment never
reaches the web server; the code is drawn in the page (`uqr`) and removed
when the owner is done. The phone learns each home-network address on first
open, as any browser does.

Three Homeys make a code of about 800 characters (QR version 23), which an
independent decoder read from the 320 px rendering; past about eight Homeys
one code cannot hold them all, and the launcher draws a code per Homey. On the
phone the launcher removes the fragment from the address bar first, then asks
before adding, and saves everything in one write.

A code could be made by anyone. It may only carry Athom cloud addresses for
the Homeys it names, as a pasted address may, and a code with anything else is
refused whole. A key in a code replaces a key the phone already has for that
Homey only once Homey accepts it, so a crafted code cannot knock out a working
key; a Homey already listed keeps the addresses learned for it.

## Several Homeys, one version each

The settings UI and its routes change together in every release, and one
browser can face several Homeys on different PELS versions. So each release
publishes its own build at `v<version>/`, and a version-independent launcher at
the root:

- keeps the owner's Homeys (localStorage `pels.webapp.homeys.v1`, shared by the
  launcher and every build because they share an origin; the record may only
  gain optional fields, so `baseUrl` stays the cloud address every build can
  use and the home-network address is the optional `localUrl`),
- reads each Homey's version from `GET /ui_version` and opens the build for it
  (the route also returns the Homey's timezone, which the key cannot read from
  Homey itself),
- tells the owner to update PELS when the route is missing (404), to wait when
  the version is newer than every published build, and says when PELS is
  installed but not running (Homey answers 503).

Homey answers an unknown app route with 404 before it checks the key, so on a
PELS that predates `ui_version` the version read cannot vouch for a key. The
add form checks the key with an app-settings read, which always checks it.

A build compares the running version with its own on load and returns to the
launcher, naming its Homey (`?open=<id>`), when PELS has updated, stopped or
gone since. The settings UI navigates with query-string routes that drop the
`#homey=` fragment, so a tab keeps its Homey in session storage across those
navigations and reloads; a link opened in a new tab falls back to the Homey
opened last.

## Publishing

The web app lives at `https://pels.barelysufficient.org/app/`, next to the docs.

- Every release tag runs `.github/workflows/webapp-build.yml`: it builds that
  tag's web app and stores its `v<version>/` in the `webapp-builds` branch, one
  squashed commit holding the newest 40 versions
  (`scripts/webapp-site.mjs store`), then redeploys the docs. A release from
  before the web app has no such workflow, so nothing runs for it.
- The docs deploy (`.github/workflows/docs.yml`) builds the launcher, manifest
  and icons from main, copies every stored build next to them and writes
  `versions.json` (`scripts/webapp-site.mjs assemble`). Launcher changes go live
  with the next main push, without a release.
- Test-channel versions are tags too, so they get builds before Live does.
- From the published site, the home-network address
  (`*.homey.homeylocal.com`, which resolves to a private IP) is a request from
  a public site into the local network, which Chrome may put behind a
  permission prompt. When it is refused, or a router blocks private answers
  for public names (DNS rebinding protection), the ping fails and the cloud
  address serves.
- GitHub Pages caches files for up to 10 minutes, so a new build can take that
  long to appear; the launcher says to try again in a few minutes meanwhile.
- `manifest.webmanifest` (start URL and scope `/app/`, standalone) and the icons
  make it installable from Chrome over HTTPS; no service worker is needed for
  that, and the data is live anyway. The icons are `assets/icon.svg` on the
  dark background (`#0c111b`) in the accent green (`#4ade80`), rendered with
  Inkscape; the maskable one keeps the glyph inside the 60 % safe zone.

## From the Homey settings page

Settings → Open in a browser walks through adding the Homey on a computer and
then the phone, shows this Homey's address to copy and links to
`/app/?open=<homeyId>`, which opens that Homey once the
owner has added it. When Homey's web app serves the page from the Homey's own
cloud host, that host is the address shown and the link carries it
(`&via=<host>`); otherwise the address is the bare id from `ui_version`. The
web app takes `via` only for a Homey it already lists, only an Athom host
named for that Homey, and only once that host answers a ping. It never fills in the add form from a link: where an API
key is sent must come from the owner, or a crafted link naming someone else's
Homey could collect keys. The web app removes this entry from its own settings
hub.

## Load time

Measured on the test Homey: about 40 requests per boot in about 7 sequential
waves. Through the cloud a small request takes about 0.35 s and `ui_bootstrap`
0.8 to 1.4 s, so a boot costs roughly 3 to 4 s; on the home network the waves
cost little. Duplicate reads all fall in
the same wave as their twin, so sharing in-flight reads saves requests but not
time, and it weakens the settings UI's "newer refresh wins" guards; it was
tried and dropped. Fewer waves is the lever, for example `ui_bootstrap`
carrying the settings the UI reads one by one right after it.
