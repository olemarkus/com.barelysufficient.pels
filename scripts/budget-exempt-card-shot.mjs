// Standalone screenshot harness for the Overview held-card "Let it run now"
// rescue chip and the corrected budget reason/status lines on the REAL device
// card types users actually own: PlanTemperatureCard (a thermostat) and
// PlanSteppedCard (a water heater).
//
// Renders the GENUINE Preact components (not hand-written HTML) — esbuild
// bundles a tiny entry that imports the real PlanTemperatureCard /
// PlanSteppedCard and mounts them with preact `render`, against the real
// style.css + tokens.css, at both 480px and 320px. Each rendered device is
// budget-held (cause='budget', isStarved true, plannedState='shed') with a
// daily-bound insufficient_headroom reason, so the card shows the "Budget
// limited" badge + "Let it run now" rescue chip + the corrected "Limited to
// stay within today's budget" reason/status line (NOT the contradictory
// "Waiting for available power" / hard-cap framing).
//
// The chip is gated on the server-resolved rescuable set, so the entry seeds
// `state.starvationRescuableDeviceIds` with both device ids. A second pass clicks
// the thermostat's chip once to ARM the two-step confirm and shoots the armed
// (warning-toned "Confirm") state.
//
// Coarse pointer + mobile so the designer-tuned dark palette applies (no
// desktop invert). Not part of the test suite; run on demand.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'packages', 'settings-ui');
const OUT = path.join(ROOT, 'docs-shots');
mkdirSync(OUT, { recursive: true });

const css = readFileSync(path.join(UI, 'public', 'style.css'), 'utf8');
// Prefer the freshly-built design tokens (`packages/settings-ui/dist/tokens.css`)
// when a build has run, but fall back to the committed bundle copy
// (`settings/tokens.css`, byte-identical, produced by `build:settings`) so the
// harness runs on a clean clone with no prior build. Both paths carry the same
// tokens, so the screenshots are identical either way.
const tokensDistPath = path.join(UI, 'dist', 'tokens.css');
const tokensFallbackPath = path.join(ROOT, 'settings', 'tokens.css');
const tokensPath = existsSync(tokensDistPath) ? tokensDistPath : tokensFallbackPath;
const tokens = readFileSync(tokensPath, 'utf8');

// ─── Harness entry: mount the REAL card components ──────────────────────────────
// Each device is a genuine budget-held snapshot (cause='budget', isStarved,
// plannedState='shed') whose reason.code on its own would render the
// contradictory capacity-waiting copy; the producer-resolved budget cause now
// wins, so the reason/status line reads the budget attribution. The rescuable
// set is seeded so the gated chip renders; previewStarvationRescue is stubbed via
// the host Homey shim (no network in the harness).
const entrySource = `
import { h, render } from 'preact';
import { PlanTemperatureCard } from '${UI}/src/ui/views/PlanDeviceCards.tsx';
import { PlanSteppedCard } from '${UI}/src/ui/views/PlanSteppedCard.tsx';
import { setHomeyClient } from '${UI}/src/ui/homey.ts';
import { state } from '${UI}/src/ui/state.ts';

// Wire the rescue controller's API client to the host Homey shim so arming the
// chip resolves a real (stubbed) preview — the armed caption then shows the
// bounded "By {time}" horizon the docs need to depict, not just the fallback.
setHomeyClient(window.Homey);

state.starvationRescuableDeviceIds = new Set(['heater-1', 'heater-2']);

const budgetStarvation = { isStarved: true, accumulatedMs: 300000, cause: 'budget', startedAtMs: 0 };
const insufficientHeadroom = { code: 'insufficient_headroom', needKw: 2, effectiveAvailableKw: 0 };

const thermostat = {
  id: 'heater-1',
  name: 'Termostat Synne',
  controlModel: 'temperature_target',
  plannedState: 'shed',
  currentState: 'on',
  currentTemperature: 19.4,
  currentTarget: 22,
  plannedTarget: 22,
  measuredPowerKw: 0,
  reason: insufficientHeadroom,
  starvation: budgetStarvation,
};

const waterHeater = {
  id: 'heater-2',
  name: 'Varmtvannsbereder',
  controlModel: 'stepped_load',
  plannedState: 'shed',
  currentState: 'off',
  measuredPowerKw: 0,
  reason: insufficientHeadroom,
  starvation: budgetStarvation,
  steppedLoad: {
    profile: { model: 'stepped_load', steps: [ { id: 'off', planningPowerW: 0 }, { id: '1', planningPowerW: 2000 } ] },
    reportedStepId: 'off',
    targetStepId: '1',
    commandPending: false,
  },
};

const mount = document.getElementById('plan-cards');
const props = { plan: null, renderedAtMs: 1000, nowMs: 1000 };
render(
  h('div', null,
    h(PlanTemperatureCard, { dev: thermostat, ...props }),
    h(PlanSteppedCard, { dev: waterHeater, ...props }),
  ),
  mount,
);
`;

// The entry lives inside packages/settings-ui so esbuild's upward node
// resolution finds `preact` (a settings-ui dependency); `os` import kept for
// callers that prefer the system temp root.
void os;
const tmp = mkdtempSync(path.join(UI, '.card-shot-tmp-'));
const entryFile = path.join(tmp, 'entry.tsx');
writeFileSync(entryFile, entrySource);

const bundle = await build({
  entryPoints: [entryFile],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  absWorkingDir: ROOT,
  logLevel: 'error',
});
const script = bundle.outputFiles[0].text;

// Stub the Homey API the rescue controller would call when a chip is armed/
// committed, so the harness needs no live runtime. Preview returns a bounded
// deadline; create succeeds. Installed before the bundle runs.
const homeyShim = `
window.Homey = {
  ready: () => Promise.resolve(),
  get: (k, cb) => cb(null, undefined),
  set: (k, v, cb) => cb(null),
  api: (method, uri, body, cb) => {
    const done = typeof body === 'function' ? body : cb;
    if (String(uri).includes('preview')) return done(null, { ok: true, deadlineAtMs: 1, deadlineLabel: 'Today 17:00', estimate: { scheduledHours: [] } });
    if (String(uri).includes('create')) return done(null, { ok: true, runsCurrentHour: true });
    return done(null, {});
  },
};
`;

const page = (body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${tokens}</style><style>${css}</style>
<style>html,body{margin:0;background:var(--bg);} .screen{padding:var(--spacing-4);}</style>
</head><body><div class="screen"><div id="plan-redesign-surface"><div id="plan-cards" class="plan-cards"></div></div></div>
<script>${homeyShim}</script><script>${body}</script></body></html>`;

const shoot = async (browser, width, file, { armConfirm = false } = {}) => {
  const ctx = await browser.newContext({
    viewport: { width, height: 520 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const p = await ctx.newPage();
  await p.setContent(page(script), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(150);
  if (armConfirm) {
    // First tap of the two-step confirm — arms the warning-toned "Confirm" state
    // without committing. Target the thermostat card's rescue button.
    await p.locator('.plan-card--temperature button.plan-chip--leading-icon').first().click();
    await p.waitForTimeout(120);
    // Move the pointer off the card before capturing: a lingering hover triggers
    // the `.plan-card:hover` green elevation wash, which masks the armed amber
    // "Confirm" chip + the new consequence caption. Park the cursor at the corner
    // so the armed state photographs as users actually see it on touch.
    await p.mouse.move(0, 0);
    await p.waitForTimeout(120);
  }
  await p.screenshot({ path: path.join(OUT, file), fullPage: true });
  await ctx.close();
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

// Real PlanTemperatureCard (thermostat) + PlanSteppedCard (water heater),
// both budget-held, at both mobile widths — showing the "Let it run now" chip.
await shoot(browser, 480, 'budget-exempt-real-cards-480.png');
await shoot(browser, 320, 'budget-exempt-real-cards-320.png');
// The armed-confirm state (first tap → warning-toned "Confirm").
await shoot(browser, 480, 'budget-exempt-confirm-480.png', { armConfirm: true });
await shoot(browser, 320, 'budget-exempt-confirm-320.png', { armConfirm: true });

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log('wrote real-card "Let it run now" shots (480 + 320, idle + armed-confirm) to', OUT);
