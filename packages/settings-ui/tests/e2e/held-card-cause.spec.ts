import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTest as test, expect, type Page } from './fixtures/test';

// End-to-end proof of the 2026-08-02 split, driven through the UI seam with the
// state observed in production: the daily budget is the binding ceiling, four
// devices are held, and the runtime knows "Limited by today's daily budget".
//
// Before the split, the card for a binary-shed thermostat in exactly this state
// read "Turned off by PELS" — a line that restated the bold `Limited` state word
// and named no cause, while the correct sentence sat unused in the same
// snapshot. Now the hero names the ceiling once and each card states what its
// own device needs.
//
// Prod reference (2026-08-02T12:34:42Z): softLimitSource `daily`, safe pace
// 1.85 kW, house 0.82 kW, `Termostat hovedbad` shed with reason `daily_budget`,
// expected draw 1.14 kW, admission short by 0.9 kW (need 1.36, available 1.03, two 0.25 kW reserves).
const OUT_DIR = process.env.PELS_HELD_CARD_OUT_DIR ?? path.join(os.tmpdir(), 'pels-held-card-shots');

// The stub defaults to simulation mode, where the state word goes factual
// (`Off`) because PELS acted on nothing. This spec is about the real-mode card.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: { capacity_dry_run: false },
    };
  });
});

const applyProdHeldState = async (page: Page) => {
  await page.evaluate(() => {
    type PlanDevice = Record<string, unknown> & { id: string };
    type PlanSnapshot = { devices: PlanDevice[]; meta: Record<string, unknown> };
    type StubWindow = Window & {
      Homey: {
        __stub: {
          getSetting: (key: string) => unknown;
          emitHomeyEvent: (event: string, payload: unknown) => void;
        };
      };
    };

    const homey = (window as unknown as StubWindow).Homey;
    const plan = homey.__stub.getSetting('plan_snapshot') as PlanSnapshot;
    const base = plan.devices.find((candidate) => candidate.id === 'dev_bedroom');
    if (!base) throw new Error('Missing fixture plan device dev_bedroom');

    homey.__stub.emitHomeyEvent('plan_updated', {
      ...plan,
      meta: {
        ...plan.meta,
        // The daily budget binds, and the hard cap is nowhere near it — the
        // shape that made a card reading "Limited by the hard cap" a lie.
        totalKw: 0.82,
        softLimitKw: 1.85,
        headroomKw: 1.03,
        softLimitSource: 'daily',
        hardCapLimitKw: 10.05,
      },
      devices: [
        {
          ...base,
          id: 'dev_bedroom',
          name: 'Termostat hovedbad',
          currentState: 'off',
          plannedState: 'shed',
          stateKind: 'held',
          stateTone: 'held',
          shedAction: 'turn_off',
          temperature: { currentTarget: 22, currentTemperature: 20.3, plannedTarget: 22 },
          currentDrawKw: 0,
          expectedPowerKw: 1.14,
          reason: { code: 'daily_budget', shortfallKw: 0.9 },
        },
      ],
    });
  });
  await page.waitForTimeout(300);
};

const reasonLine = (page: Page) => page.locator(
  '#plan-cards [data-device-id="dev_bedroom"] :is(.plan-card__reason, .plan-card__temp-reason, .plan-card__status-line)',
);

// Scoped to the Power-now section: the hero has several sublines and the daily
// budget block renders one before it.
const heroSubline = (page: Page) => page.locator('.plan-hero .plan-hero__section')
  .filter({ hasText: 'Power now' })
  .locator('.plan-hero__subline:not(.plan-hero__subline--muted)')
  .first();

test('the hero names the binding ceiling and the card states what the device needs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await applyProdHeldState(page);

  // The hero owns the house-level fact — visible text, not a hover tooltip.
  await expect(heroSubline(page)).toHaveText("Safe pace now 1.9 kW · set by today's budget");

  // The card owns the per-device fact.
  await expect(reasonLine(page)).toHaveText('Waiting to resume — 0.9 kW more needed');
});

test('the card never repeats the ceiling or claims PELS turned the device off', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await applyProdHeldState(page);

  // Scoped to the Overview's card container: `data-device-id` is also stamped
  // on the Devices list row and the Modes row/target input, and those panels
  // paint at boot now that the Overview loads the device payload.
  const card = page.locator('#plan-cards [data-device-id="dev_bedroom"]');
  const text = (await card.textContent()) ?? '';
  for (const retired of [
    'Turned off by PELS',
    'Lowered by PELS',
    'Limited by the hard cap',
    "Limited by today's daily budget",
  ]) {
    expect(text).not.toContain(retired);
  }
  // The state word still carries that PELS is acting.
  await expect(card.locator('.plan-card__state-label')).toHaveText('Limited');
});

// Review harness — writes the rendered hero + card so the copy can be judged on
// screen rather than in the diff. Skipped unless PELS_CAPTURE_HELD_CARD=1.
test('captures the hero and held card (360 dark)', async ({ page, browserName }) => {
  test.skip(process.env.PELS_CAPTURE_HELD_CARD !== '1', 'Capture harness — run explicitly');
  test.skip(browserName !== 'chromium', 'Dark (touch) capture is chromium-only');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await applyProdHeldState(page);

  // Page-level, not locator-level: the hero's live meters never settle into two
  // identical frames, so a locator screenshot's stability wait never resolves.
  await page.screenshot({
    path: path.join(OUT_DIR, 'overview.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
