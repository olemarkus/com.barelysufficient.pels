/**
 * Captures real dashboard-widget screenshots for the docs (`docs/widgets.md`).
 *
 * Unlike each widget's `scripts/build-previews.mjs` — which renders a hand-drawn
 * SVG mockup for the Homey app-store gallery — this script boots the ACTUAL
 * built widget (`widgets/<name>/public/index.html`) in `?preview=1` mode, so the
 * screenshots show the widget's real markup, CSS and rendered preview data. The
 * interactive widgets (New smart task, Held-back devices) are driven through
 * their multi-step flow, one screenshot per step.
 *
 * The widgets render in their LIGHT-theme fallbacks (the `--pw-*` tokens carry
 * the light Homey base-token values as fallbacks), which matches the existing
 * light-theme docs landing screenshots. Homey draws the surrounding card chrome
 * on a real dashboard; here we simulate it (white rounded card + shadow on a
 * neutral dashboard background) so the doc image reads like a pinned widget.
 *
 * Run locally (not in CI):
 *   node scripts/build-doc-widget-screenshots.mjs
 */
// `chromium` is re-exported by the declared `@playwright/test` devDependency;
// import it from there rather than the transitively-installed `playwright`.
import { chromium } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(repoRoot, 'docs', 'public', 'screenshots', 'widgets');

// Homey renders a small widget in a ~ phone-column-width card. 360 keeps the
// content honest at a realistic dashboard width without crowding.
const VIEWPORT = { width: 360, height: 900 };

// Simulated Homey dashboard card chrome. Injected after the widget renders so
// the doc image reads like a pinned widget rather than bare body content.
const CARD_CHROME_CSS = `
  html, body { margin: 0; background: #e9edf0 !important; }
  body { box-sizing: border-box; padding: 20px; }
  #widget-root {
    box-sizing: border-box;
    background: #ffffff;
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.06);
  }
`;

const widgetUrl = (name, params) => {
  const file = path.join(repoRoot, 'widgets', name, 'public', 'index.html');
  const search = new URLSearchParams({ preview: '1', ...params }).toString();
  return `${pathToFileURL(file).href}?${search}`;
};

/** Screenshot just the simulated card (body), tightly cropped to its content. */
const shoot = async (page, file) => {
  await page.waitForTimeout(250);
  // `animations: 'disabled'` freezes CSS transitions/animations at capture time
  // so a mid-transition frame can't sneak into a committed screenshot.
  await page.locator('body').screenshot({ path: path.join(outDir, file), animations: 'disabled' });
  console.log(`  wrote ${file}`);
};

const openWidget = async (context, name, { params = {}, height } = {}) => {
  const page = await context.newPage();
  // `homey-widget-full` widgets are `height: 100%` flex layouts that Homey sizes
  // to a fixed card height; standalone they would stretch to the viewport and
  // leave a gap. Pin a realistic full-widget height for those.
  if (height) await page.setViewportSize({ width: VIEWPORT.width, height });
  await page.goto(widgetUrl(name, params), { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: CARD_CHROME_CSS });
  await page.waitForTimeout(400);
  return page;
};

const run = async () => {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  // `finally` guarantees the headless browser is torn down even if a capture
  // throws, so a failed run can't orphan a Chromium process.
  try {
    await capture(browser);
  } finally {
    await browser.close();
  }
  console.log(`\nDone. Screenshots in ${path.relative(repoRoot, outDir)}/`);
};

const capture = async (browser) => {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  // --- Static widgets: one screenshot each ---
  console.log('Available power (headroom)');
  {
    const page = await openWidget(context, 'headroom');
    await shoot(page, 'available-power.png');
    await page.close();
  }

  console.log('Budget and Price (plan_budget)');
  {
    const page = await openWidget(context, 'plan_budget', { height: 415 });
    await shoot(page, 'budget-and-price.png');
    await page.close();
  }

  console.log('Smart tasks (smart_tasks)');
  {
    const page = await openWidget(context, 'smart_tasks');
    await shoot(page, 'smart-tasks.png');
    await page.close();
  }

  // --- Interactive widgets: one screenshot per flow step ---
  console.log('New smart task (create_smart_task)');
  {
    const page = await openWidget(context, 'create_smart_task');
    await shoot(page, 'new-smart-task-1-pick-device.png');
    await page.locator('[data-device-button]').first().click();
    // Wait for the compose step's primary control rather than a fixed delay.
    await page.locator('[data-preview-btn]').waitFor({ state: 'visible' });
    await shoot(page, 'new-smart-task-2-set-goal.png');
    await page.locator('[data-preview-btn]').click();
    await page.waitForTimeout(500);
    await shoot(page, 'new-smart-task-3-preview.png');
    await page.close();
  }

  console.log('Held-back devices (starvation_rescue)');
  {
    const page = await openWidget(context, 'starvation_rescue');
    await shoot(page, 'held-back-1-list.png');
    await page.locator('[data-rescue-button]:not([hidden])').first().click();
    await page.waitForTimeout(500);
    await shoot(page, 'held-back-2-confirm.png');
    await page.close();
  }

  await context.close();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
