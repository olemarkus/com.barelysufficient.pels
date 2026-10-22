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
sent as `Authorization: Bearer` to the Athom cloud relay
(`https://<homeyId>.connect.athom.com`) or the Homey's LAN address. Verified in
the supervisor and live on the test Homey:

- PELS's non-public routes require exactly `homey.app.control`; Homey's
  app-settings endpoints accept it too, so `Homey.get`/`set`/`api` map one to
  one onto REST.
- The scope is not per app: the key can read and change every app's settings.
  The add form says so.
- Only the owner can create API keys; users and guests hold
  `homey.app.readonly`, which cannot call PELS routes.
- Self-registered OAuth clients only get read-only app scopes, so a "log in
  with Homey" flow cannot replace the key.
- The relay answers CORS preflights for `authorization` and `content-type`
  with `access-control-allow-origin: *`.

Realtime uses Homey's socket.io v2 protocol (`handshakeClient` with the key,
then `subscribe` to `homey:app:<id>` on the returned namespace). It carries the
same events the WebView delivers, `settings.set`/`settings.unset` included. The
relay socket works on a Homey Pro (verified with the owner's own session); on
the self-hosted test Homey it answers `homey_offline`, so test realtime there
over the LAN address.

Homey only sends settings events while the socket is up, and the settings UI
caches settings until one arrives. After a reconnect the build compares all
PELS settings with the copy taken while live and announces each difference as
the event Homey would have sent; a key announced while live is announced again,
so a value changed and changed back across the drop is not missed. Runtime read
models catch up on their own refresh timers or with the next event.

## Several Homeys, one version each

The settings UI and its routes change together in every release, and one
browser can face several Homeys on different PELS versions. So each release
publishes its own build at `v<version>/`, and a version-independent launcher at
the root:

- keeps the owner's Homeys (localStorage `pels.webapp.homeys.v1`, shared by the
  launcher and every build because they share an origin; the record may only
  gain optional fields),
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
- From the published site, a Homey's LAN address (`*.homey.homeylocal.com`,
  which resolves to a private IP) is a request from a public site into the
  local network, which Chrome may put behind a permission prompt; the cloud
  address (`<homeyId>.connect.athom.com`) is not affected.
- GitHub Pages caches files for up to 10 minutes, so a new build can take that
  long to appear; the launcher says to try again in a few minutes meanwhile.
- `manifest.webmanifest` (start URL and scope `/app/`, standalone) and the icons
  make it installable from Chrome over HTTPS; no service worker is needed for
  that, and the data is live anyway. The icons are `assets/icon.svg` on the
  dark background (`#0c111b`) in the accent green (`#4ade80`), rendered with
  Inkscape; the maskable one keeps the glyph inside the 60 % safe zone.

## From the Homey settings page

Settings → Open in a browser explains the API key, shows this Homey's address
to copy (the id comes from `ui_version`) and links to `/app/?open=<homeyId>`,
which opens that Homey once the owner has added it. The web app never fills in
an address from a link: where an API key is sent must come from the owner, or
a crafted link naming someone else's Homey could collect keys. The web app
removes this entry from its own settings hub.

## Load time

Measured on the test Homey: about 40 requests per boot in about 7 sequential
waves. Through the relay a small request takes about 0.35 s and `ui_bootstrap`
0.8 to 1.4 s, so a boot costs roughly 3 to 4 s. Duplicate reads all fall in
the same wave as their twin, so sharing in-flight reads saves requests but not
time, and it weakens the settings UI's "newer refresh wins" guards; it was
tried and dropped. Fewer waves is the lever, for example `ui_bootstrap`
carrying the settings the UI reads one by one right after it.
