// Widget screenshot harness — renders each Homey dashboard widget in its
// `?preview=1` state in BOTH themes at 480px and 320px: dark against an
// injected `--homey-*` DARK token set (the tokens Homey supplies at runtime),
// light with NO tokens so every `var(--homey-*, fallback)` resolves to its
// in-CSS light fallback. Produces
// tests/widget-shots/out/<widget>-<width>[-<state>][-light].png.
//
// Run: node tests/widget-shots/shoot.mjs
// (Reads the COMMITTED widget bundles in widgets/*/public/, so run `npm run
// build:widgets` first if you changed widget source.)
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

// Representative Homey dark-theme token values (from plan_budget's own
// `.homey-dark-mode` block + the dark-side `var(--homey-*, …)` fallbacks the
// widgets ship). One canonical value per token, so latent fallback divergence
// across widgets renders as Homey actually resolves it (defined, not missing).
const DARK_TOKENS = `
:root, body, .homey-dark-mode, body.homey-dark-mode {
  --homey-background-color: #161b21;
  --homey-color-mono-050: #232b33;
  --homey-color-mono-100: #1f262d;
  --homey-color-white: #ffffff;
  --homey-color-blue: #3f9fff;
  --homey-color-green: #58c56a;
  --homey-color-red: #f0696c;
  --homey-color-danger: #f0696c;
  --homey-color-success: #58c56a;
  --homey-color-warning: #f5a623;
  --homey-text-color: #edf1f4;
  --homey-text-color-light: #97a2ab;
  --homey-text-color-danger: #f0696c;
  --homey-text-color-success: #58c56a;
  --homey-text-color-warning: #f5a623;
  --homey-line-color: rgba(255, 255, 255, 0.14);
  --homey-line-color-light: rgba(255, 255, 255, 0.09);
  --homey-border-radius-default: 10px;
  --homey-border-radius-small: 6px;
  --homey-font-size-default: 17px;
  --homey-font-size-large: 20px;
  --homey-font-size-small: 14px;
  --homey-font-weight-bold: 700;
  --homey-font-weight-medium: 500;
  --homey-font-weight-regular: 400;
  --homey-line-height-default: 24px;
  --homey-line-height-large: 28px;
  --homey-line-height-small: 20px;
  --homey-su-1: 4px;
  --homey-su-2: 8px;
  --homey-su-3: 12px;
}
/* Homey wraps each widget in a padded dark card; emulate so the tile doesn't
   sit edge-to-edge on the page background. The host also supplies the inherited
   text colour — without it, anything relying on inheritance renders black on
   dark, which is exactly the class of bug these shots must catch. */
html, body { background: #0f1419; margin: 0; }
body { padding: 12px; color: var(--homey-text-color, #1f252a); }
/* Homey renders widgets in a system sans-serif; without this the page falls back
   to a serif (wider glyphs → false text-overflow). Match a representative sans. */
html, body, * { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important; }
`;

// Light theme: NO tokens injected — the widgets' in-CSS `var(--homey-*, …)`
// fallbacks ARE the light values, exactly like a standalone preview. Only the
// page chrome (light dashboard canvas + the same padding/font) is supplied.
const LIGHT_TOKENS = `
html, body { background: #eef1f4; margin: 0; }
body { padding: 12px; }
html, body, * { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important; }
`;

const THEMES = [
  { theme: 'dark', tokens: DARK_TOKENS, suffix: '' },
  { theme: 'light', tokens: LIGHT_TOKENS, suffix: '-light' },
];

const WIDGETS = ['plan_budget', 'headroom', 'starvation_rescue', 'smart_tasks', 'create_smart_task'];
const WIDTHS = [480, 320];
// Extra captures: headroom's limit-states (selected via ?state=), so the
// at-limit softening (amber at_pace / red over_cap) is visible, not just `under`.
const HEADROOM_STATES = ['near', 'at_pace', 'over_cap'];

// Render one widget page at one width and write `<name>.png`. Captures console +
// page errors so a broken render is reported, not silently shot. `interact`
// (optional) drives the widget into a deeper state — e.g. tapping a list row to
// open a detail panel — after the initial preview render and before the shot.
const capture = async (browser, { url, width, name, theme = 'dark', tokens = DARK_TOKENS, interact }) => {
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2, colorScheme: theme });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(url);
    await page.addStyleTag({ content: tokens });
    // Let the widget bundle render the preview payload (+ any chart draw).
    await page.waitForTimeout(900);
    if (interact) {
      await interact(page);
      await page.waitForTimeout(400);
    }
    const root = await page.$('#widget-root');
    await (root ?? page).screenshot({ path: path.join(OUT, `${name}.png`) });
    if (errors.length) console.error(`[${name}] console errors:\n  ${errors.join('\n  ')}`);
    else console.log(`shot ${name}.png`);
  } finally {
    await page.close();
  }
};

const indexUrl = (widget, params) => {
  const indexPath = path.join(ROOT, 'widgets', widget, 'public', 'index.html');
  return { exists: fs.existsSync(indexPath), url: `file://${indexPath}?${params}` };
};

const browser = await chromium.launch();
try {
  for (const { theme, tokens, suffix } of THEMES) {
    for (const widget of WIDGETS) {
      const { exists, url } = indexUrl(widget, `preview=1&theme=${theme}`);
      if (!exists) { console.error(`MISSING widgets/${widget}/public/index.html`); continue; }
      for (const width of WIDTHS) {
        await capture(browser, { url, width, name: `${widget}-${width}${suffix}`, theme, tokens });
      }
    }
    // Headroom limit-states at 480px (selected via ?state=).
    for (const state of HEADROOM_STATES) {
      const { url } = indexUrl('headroom', `preview=1&theme=${theme}&state=${state}`);
      await capture(browser, { url, width: 480, name: `headroom-480-${state}${suffix}`, theme, tokens });
    }
    // plan_budget over-budget tone (selected via ?tone=over), so the red status
    // chip is exercised at both widths — on_track + null are the default captures.
    for (const width of WIDTHS) {
      const { url } = indexUrl('plan_budget', `preview=1&theme=${theme}&tone=over`);
      await capture(browser, { url, width, name: `plan_budget-${width}-over${suffix}`, theme, tokens });
    }
    // smart_tasks detail views (interaction-driven): the trajectory chart —
    // run bands + smoothed measured line — only renders inside the detail
    // panel, so tap into it. Active = the at-risk hot-water task; ended = the
    // succeeded EV run (exercises the met marker on the same chart path).
    // Captured at BOTH widths like the top-level states — the chart legend and
    // detail lines are exactly the content that wraps/overflows at 320px.
    for (const width of WIDTHS) {
      const { url } = indexUrl('smart_tasks', `preview=1&theme=${theme}`);
      await capture(browser, {
        url,
        width,
        name: `smart_tasks-${width}-detail${suffix}`,
        theme,
        tokens,
        interact: async (page) => {
          await page.click('[data-row-button][data-device-id="preview-hot-water"]');
          await page.waitForSelector('svg.tchart');
        },
      });
      await capture(browser, {
        url,
        width,
        name: `smart_tasks-${width}-detail-ended${suffix}`,
        theme,
        tokens,
        interact: async (page) => {
          await page.click('[data-ended-button][data-history-id="preview-ev-ended"]');
          await page.waitForSelector('svg.tchart');
        },
      });
    }
    // create_smart_task compose→preview (interaction-driven): pick the first
    // device, then request the preview so the price-window chart (pchart) is
    // exercised, not just the picker list. Both widths, same reason as above.
    for (const width of WIDTHS) {
      const { url } = indexUrl('create_smart_task', `preview=1&theme=${theme}`);
      await capture(browser, {
        url,
        width,
        name: `create_smart_task-${width}-preview${suffix}`,
        theme,
        tokens,
        interact: async (page) => {
          await page.click('[data-device-button]');
          await page.click('[data-preview-btn]');
          await page.waitForSelector('svg.pchart');
        },
      });
    }
  }
} finally {
  await browser.close();
}
