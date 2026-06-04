// Widget screenshot harness — renders each Homey dashboard widget in its
// `?preview=1` state against an injected `--homey-*` DARK token set (the tokens
// Homey supplies at runtime; standalone preview only has the in-CSS fallbacks),
// at 480px and 320px. Produces tests/widget-shots/out/<widget>-<width>[-<state>].png.
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
   sit edge-to-edge on the page background. */
html, body { background: #0f1419; margin: 0; }
body { padding: 12px; }
/* Homey renders widgets in a system sans-serif; without this the page falls back
   to a serif (wider glyphs → false text-overflow). Match a representative sans. */
html, body, * { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important; }
`;

const WIDGETS = ['plan_budget', 'headroom', 'starvation_rescue', 'smart_tasks', 'create_smart_task'];
const WIDTHS = [480, 320];
// Extra captures: headroom's limit-states (selected via ?state=), so the
// at-limit softening (amber at_pace / red over_cap) is visible, not just `under`.
const HEADROOM_STATES = ['near', 'at_pace', 'over_cap'];

// Render one widget page at one width and write `<name>.png`. Captures console +
// page errors so a broken render is reported, not silently shot.
const capture = async (browser, { url, width, name }) => {
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(url);
    await page.addStyleTag({ content: DARK_TOKENS });
    // Let the widget bundle render the preview payload (+ any chart draw).
    await page.waitForTimeout(900);
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
  for (const widget of WIDGETS) {
    const { exists, url } = indexUrl(widget, 'preview=1&theme=dark');
    if (!exists) { console.error(`MISSING widgets/${widget}/public/index.html`); continue; }
    for (const width of WIDTHS) {
      await capture(browser, { url, width, name: `${widget}-${width}` });
    }
  }
  // Headroom limit-states at 480px (selected via ?state=).
  for (const state of HEADROOM_STATES) {
    const { url } = indexUrl('headroom', `preview=1&theme=dark&state=${state}`);
    await capture(browser, { url, width: 480, name: `headroom-480-${state}` });
  }
  // plan_budget over-budget tone (selected via ?tone=over), so the red status
  // chip is exercised at both widths — on_track + null are the default captures.
  for (const width of WIDTHS) {
    const { url } = indexUrl('plan_budget', 'preview=1&theme=dark&tone=over');
    await capture(browser, { url, width, name: `plan_budget-${width}-over` });
  }
} finally {
  await browser.close();
}
