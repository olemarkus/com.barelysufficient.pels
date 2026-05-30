# Desktop-light / mobile-dark theme model

> **Status: shipped** (`967365c5` — light desktop theme, counter-filter dropped).
> This is the design-of-record for the live behaviour, not a proposal. The
> `(hover: hover) and (pointer: fine)` gate is in `settings/style.css`; the old
> `prefers-color-scheme` counter-filter survives only as a comment.

## Context

Homey's web shell unconditionally applies `filter: invert(1) hue-rotate(180deg)` to every embedded settings iframe when the parent `<html>` has class `darkTheme` — on **desktop** only. Homey mobile never applies that filter. Homey assumes every settings app is a light-canvas surface and uses the desktop filter as its dark-mode mechanism.

The PELS settings UI was originally designed dark-only and shipped a counter-filter (`@media (prefers-color-scheme: dark) { :root { filter: invert(1) hue-rotate(180deg) } }`) to cancel Homey's invert. The counter-filter proxied "Homey is in dark mode" via the OS `prefers-color-scheme` signal, and broke whenever OS theme and Homey theme disagreed (most commonly: OS dark + Homey light on desktop → PELS rendered inverted to a near-white "broken light" surface with hue-shifted status semantics).

We retired that approach in favour of a Homey-native design: PELS ships as a **light-canvas app on desktop** and lets Homey's own invert produce the dark skin. Mobile keeps today's designer-tuned dark palette unchanged.

## The signal that does not exist

Before redesigning, we verified empirically that no in-iframe signal exists for Homey's parent theme. Live probing against the test Homey at `https://my.homey.app/homeys/69ec731ed5c71c23b9304203/settings/apps/com.barelysufficient.pels` via Playwright Firefox produced:

| Probe | Result |
|---|---|
| Iframe origin | `*.homey.homeylocal.com:4860` (cross-origin to `my.homey.app`) |
| Iframe sandbox | `allow-scripts allow-forms` — **no** `allow-same-origin` |
| `window.parent.document` from iframe | throws "Permission denied to access property `document` on cross-origin object" |
| `window.parent.location.href` from iframe | throws "Permission denied to get property `href`" |
| `window.frameElement` from iframe | `null` |
| iframe `src` URL params/hash | none |
| `document.referrer` | `https://my.homey.app/` — origin only, no theme info |
| `postMessage` from parent during forced `lightTheme ↔ darkTheme` toggle | only PELS's own `pels_status` RPC callbacks; **no** theme payload |
| Canvas readback inside iframe (white pixel, red pixel) | `[255,255,255,255]` / `[255,0,0,255]` in both parent themes — the iframe-element filter is parent-compositor-applied, invisible to in-iframe scripts |
| `(inverted-colors: inverted)` media query | `false` in both themes |
| `(forced-colors: active)` media query | `false` in both themes |
| Homey-injected `homey.css` inside iframe | byte-identical URL in both themes; `--homey-color-white: #ffffff` and `--homey-color-text: #181818` identical in both |
| `Homey` JS global prototype | `ready, alert, confirm, error, getLanguage, getDevmode, popup, on, api, get, set, unset, openURL, __, translateElement` — no theme accessor |
| `Homey.get('theme' \| 'colorScheme' \| 'darkMode' \| 'system.theme' \| 'ui.theme' \| 'appearance')` | `null` for every key |
| `Homey.api('GET', '/theme' \| '/system/theme' \| '/ui/theme' \| '/appearance')` | 404 from PELS's own express router |
| `Homey.on('theme' \| 'themechange' \| 'theme.change' \| 'colorscheme' \| 'darkmode' \| 'appearance' \| '*')` | no events during parent theme toggle |
| CSS rules in injected stylesheets matching `theme/dark/light/color-scheme` | zero hits |

Every CSS-only and JS-only path inside the iframe is dead. The only path to a deterministic Homey-theme signal would be a Homey-side change (URL parameter or `postMessage` handshake), and we don't ship Homey.

## The gate

Given no Homey-theme signal, the design pivots on a different signal: **hardware**. The CSS media query `(hover: hover) and (pointer: fine)` distinguishes mobile (touch, no hover) from desktop (mouse, hover). This aligns perfectly with Homey's actual behaviour: Homey's iframe filter fires only on desktop, never on mobile. By using the hover/pointer probe as our palette gate, we get all four OS/Homey cells correct:

| OS | Homey | Surface | PELS tokens | Homey iframe filter | Composited result |
|---|---|---|---|---|---|
| any | any | mobile | dark (today) | none (mobile) | Dark ✓ |
| any | light | desktop | light | none | Light ✓ |
| any | dark | desktop | light | invert+huerot | Inverted light = dark ✓ |

OS theme drops out entirely. The OS-vs-Homey-mismatch class of bugs is gone.

The same probe is used elsewhere in `tooltips.ts` for the inverse (touch-detection) purpose.

## Palette decisions

- Saturated *default* role hues (accent green, warn amber, alert red, info blue, good teal, price lavender) stay **numerically identical** between mobile and desktop. The `invert + hue-rotate(180deg)` matrix is approximately identity on high-chroma colours, so they survive Homey's dark-mode invert with hue semantics preserved.
- State-text *soft* variants (`--color-base-{warning,good,danger}-soft`) flip: light yellow/mint/pink for mobile (readable on dark tinted containers); dark amber/teal/red for desktop (`#92400e`, `#065f46`, `#991b1b` — readable on light surfaces). Under Homey's desktop dark invert these forward to readable light tones (`#92400e → #f5a371`, `#065f46 → #71cab1`, `#991b1b → #ffaeae`, computed via the SVG `invert(1) hue-rotate(180deg)` matrix).
- Neutrals + surfaces + borders **flip lightness** for desktop. On-accent text intentionally does *not* flip: `#0c1610` on the saturated `#22c55e` accent green hits ~9.3 : 1 contrast (AA pass) while `#ffffff` on the same green is only ~1.86 : 1 (AA fail). Since the saturated default accent is identical across mobile and desktop, the dark on-accent reads correctly on both canvases. Values were sampled against Homey's own web shell aesthetic at `my.homey.app/homeys/.../devices` (`rgb(244, 244, 250)` page wash, `#1c1c1c` text, pure-white cards, near-imperceptible borders). PELS surfaces follow the same neutral tones to feel like a Homey-native app on desktop, not a third-party light theme.
- State containers (`--color-state-{positive,warning,negative,info}-bg`) intentionally stay **untinted** on desktop (resolve to `var(--color-surface-1)` = `#ffffff`). Homey's own shell never tints status surfaces — semantic state is conveyed via *border* and *text* colour, not container background. The 14 %-mix amber/red/teal/blue containers from the dark palette stay on mobile only.
- Shadows are subtle dark-toned drops on a light canvas. Under Homey's invert they become equally subtle white-toned glows on the dark skin.
- `<meta name="color-scheme">` is `"light dark"` — declares both palettes so the UA picks form-control/scrollbar defaults from user preference. CSS still drives the actual surface colours per the `@media` gate.

## Test surfaces

Local visual verification uses the captured Homey wrap fixtures and the static-server simulator:

```bash
PELS_E2E_SIMULATE_HOMEY=light node packages/settings-ui/scripts/static-server.mjs
PELS_E2E_SIMULATE_HOMEY=dark  node packages/settings-ui/scripts/static-server.mjs
```

Fixtures live under `packages/settings-ui/test/fixtures/homey-wrap/` and inject Homey's host `_base.css` / `_homey-button.css` into the iframe document in the real Homey load order. Visual baselines under `packages/settings-ui/tests/e2e/` cover Chromium desktop + Firefox mobile.

## Known trade-offs

- Desktop dark mode is *Homey-invert-derived* from the light palette, not designer-tuned. The result is hue-correct and contrast-correct but won't match today's mobile dark byte-for-byte. There is no path to fix this without a Homey-side theme signal.
- The simulator's `PELS_E2E_SIMULATE_HOMEY=dark` mode applies the iframe filter unconditionally for the dark wrap. Real-world mobile + Homey dark never applies the filter, so the simulator's "dark mobile" output is an artifact — production mobile dark = production mobile light = the native dark PELS at all times.
