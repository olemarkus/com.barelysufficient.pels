import fs from 'node:fs';
import path from 'node:path';
import { expect, injectHomeyHostCss, test, type Page } from './fixtures/test';

const OUT = process.env.PELS_NORWAY_CAPACITY_OUT_DIR ?? '../../output/playwright/norway-capacity';
const NOW = Date.parse('2026-11-18T12:30:00Z');

const seedMonthlyCapacity = async (page: Page, active: boolean, historyOnly = false): Promise<void> => {
  await page.addInitScript(({ nowMs, accepted, historyOnly: historical }) => {
    const offer = { monthKey: '2026-11', tariffIdentity: 'example', limitKw: 9.9, revision: 'r1' };
    const read = {
      state: 'ready', monthKey: '2026-11', tariffIdentity: 'example', coverage: 'complete',
      peaks: [
        { dateKey: '2026-11-18', hourStartMs: nowMs - 1_800_000, kw: 6, lowerBound: true },
        { dateKey: '2026-11-16', hourStartMs: nowMs - 174_600_000, kw: 5.3 },
        { dateKey: '2026-11-12', hourStartMs: nowMs - 520_200_000, kw: 5.2 },
      ],
      average: { state: 'recorded', kw: 5.5 }, tier: { lowerKw: 5, upperKw: 10 },
      targetBoundaryKw: 5, targetLost: true, remainingMonthCap: { state: 'bounded', limitKw: 9.9 },
      hardCapRecommendation: { state: accepted ? 'keep' : 'set', limitKw: 9.9, marginKw: 0.2 },
      advice: accepted ? { state: 'none' }
        : { state: 'suggestion', limitKw: 9.9, version: 'r1', direction: 'raise', actionable: true },
    };
    if (historical) Object.assign(read, {
      coverage: 'partial',
      hardCapRecommendation: { state: 'set', limitKw: 4.8, marginKw: 0.3 },
      peaks: [
        { dateKey: '2026-11-18', hourStartMs: Date.parse('2026-11-18T06:00:00Z'), kw: 5.17 },
        { dateKey: '2026-11-17', hourStartMs: Date.parse('2026-11-17T01:00:00Z'), kw: 4.94 },
        { dateKey: '2026-11-13', hourStartMs: Date.parse('2026-11-13T15:00:00Z'), kw: 4.66 },
      ],
      average: { state: 'recorded', kw: 4.92 }, tier: { lowerKw: 2, upperKw: 5 }, targetLost: false,
      remainingMonthCap: { state: 'bounded', limitKw: 4.8 },
      advice: { state: 'suggestion', limitKw: 4.8, version: 'r2', direction: 'lower', actionable: true },
    });
    const payload = {
      tracker: { lastPowerW: 4000, lastTimestamp: nowMs },
      readings: { state: 'received', lastPowerUpdateMs: nowMs },
      status: { state: 'live', status: { powerNowKw: 4, powerKnown: true, headroomKw: 0.8 } },
      phaseLoad: { state: 'none' }, capacityPeak: { state: 'no_completed_quarter' },
      capacityScalars: { state: 'resolved', scalars: {
        limitKw: 5, marginKw: historical ? 0.3 : 0.2, periodMinutes: 60, capacityEnabled: true,
        gridImportLimitKw: null, dryRun: true, followMonthPeak: false,
      } },
      hardCapConfiguration: { state: 'resolved', configured: true },
      norwayMonthlyCapacity: read,
      norwayMonthlyCapacityChoice: accepted
        ? { state: 'active', offer, normalLimitKw: 5 } : { state: 'normal' },
      norwayMonthlyCapacityOutcome: { state: 'idle' },
      powerHistoryRecovery: { state: 'done', requestId: 'capture', addedHours: 135 },
    };
    const stubWindow = window as unknown as { __PELS_HOMEY_STUB__: Record<string, unknown> };
    stubWindow.__PELS_HOMEY_STUB__ = {
      settings: { capacity_limit_kw: 5, capacity_margin_kw: historical ? 0.3 : 0.2 },
      apiHandlers: { 'GET /ui_power': () => payload },
    };
  }, { nowMs: NOW, accepted: active, historyOnly });
};

const mockMonthlyChoice = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const host = window as unknown as {
      Homey: { set: (key: string, value: unknown, callback: (error: unknown) => void) => void };
      __PELS_HOMEY_STUB__: { apiHandlers: Record<string, () => Record<string, unknown>> };
    };
    const original = host.Homey.set;
    const payload = host.__PELS_HOMEY_STUB__.apiHandlers['GET /ui_power']();
    const read = payload.norwayMonthlyCapacity as Record<string, unknown>;
    host.Homey.set = (key, value, callback) => {
      if (key === 'norway_capacity_choice_request') {
        const request = value as { id: string; action: string; offer?: Record<string, unknown> };
        payload.norwayMonthlyCapacityChoice = request.action === 'apply'
          ? { state: 'active', offer: request.offer, normalLimitKw: 5 } : { state: 'normal' };
        payload.norwayMonthlyCapacityOutcome = { state: 'accepted', requestId: request.id,
          message: request.action === 'apply' ? 'Capacity limit applied for this month.' : 'Normal capacity limit restored.' };
        read.advice = request.action === 'apply' ? { state: 'none' }
          : { state: 'suggestion', limitKw: 4.8, version: 'r2', direction: 'lower', actionable: true };
        read.hardCapRecommendation = { state: request.action === 'apply' ? 'keep' : 'set', limitKw: 4.8, marginKw: 0.3 };
      }
      original(key, value, callback);
    };
  });
};

for (const width of [320, 480]) {
  for (const dark of [false, true]) {
    test(`monthly capacity ${width} ${dark ? 'dark' : 'light'}`, async ({ browser, baseURL }) => {
      test.skip(process.env.PELS_CAPTURE_NORWAY_CAPACITY !== '1', 'Local design capture only');
      fs.mkdirSync(OUT, { recursive: true });
      for (const variant of ['advice', 'active', 'history']) {
        const active = variant === 'active';
        const historyOnly = variant === 'history';
        const context = await browser.newContext({ baseURL, viewport: { width, height: 1400 },
          ...(dark ? { isMobile: true, hasTouch: true } : {}),
        });
        try {
          const page = await context.newPage();
          await injectHomeyHostCss(page);
          await page.clock.setFixedTime(NOW);
          await seedMonthlyCapacity(page, active, historyOnly);
          await page.goto('/', { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => Boolean((window as unknown as {
            Homey?: { __stub?: unknown };
          }).Homey?.__stub));
          await page.evaluate(() => {
            const host = window as unknown as {
              Homey: { __stub: { emitHomeyEvent: (event: string, value: unknown) => void } };
              __PELS_HOMEY_STUB__: { apiHandlers: Record<string, () => unknown> };
            };
            host.Homey.__stub.emitHomeyEvent('power_updated', host.__PELS_HOMEY_STUB__.apiHandlers['GET /ui_power']());
          });
          await page.getByRole('tab', { name: 'Usage', exact: true }).click();
          await expect(page.locator('#monthly-capacity-card')).toBeVisible();
          await page.getByRole('tab', { name: 'Overview', exact: true }).click();
          if (active) {
            await page.getByRole('tab', { name: 'Usage', exact: true }).click();
          } else {
            const overview = page.locator('.monthly-capacity-overview');
            await expect(overview).toBeVisible();
            const gaps = await overview.evaluate((card) => {
              const bounds = card.getBoundingClientRect();
              const hero = document.querySelector('#plan-redesign-surface .plan-hero')!.getBoundingClientRect();
              const next = document.querySelector('#plan-smart-task-row')!.getBoundingClientRect();
              return [bounds.top - hero.bottom, next.top - bounds.bottom];
            });
            expect(gaps).toEqual([8, 8]);
            await page.screenshot({
              path: path.join(OUT, `overview-${variant}-${width}-${dark ? 'dark' : 'light'}.png`),
            });
            await overview.locator('[data-settings-target="usage"]').click();
          }
          await expect(page.locator('#monthly-capacity-card')).toBeVisible();
          await page.locator('#monthly-capacity-card').scrollIntoViewIfNeeded();
          await page.locator('#monthly-capacity-card').screenshot({
            path: path.join(OUT, `usage-${variant}-${width}-${dark ? 'dark' : 'light'}.png`),
          });
          const details = page.locator('#monthly-capacity-card details');
          await expect(details).not.toHaveAttribute('open');
          const collapsed = await page.locator('#monthly-capacity-card').boundingBox();
          expect(collapsed?.height).toBeLessThan(400);
          await details.locator('summary').click();
          await expect(page.locator('.monthly-capacity-peaks')).toBeVisible();
          await page.screenshot({
            path: path.join(OUT, `usage-expanded-${variant}-${width}-${dark ? 'dark' : 'light'}.png`),
          });
          if (historyOnly) {
            await mockMonthlyChoice(page);
            const card = page.locator('#monthly-capacity-card');
            await card.getByRole('button', { name: 'Use 4.8 kW this month', exact: true }).click();
            await expect(card).toContainText('Your normal 5 kW Hard cap returns on 1 December.');
            await expect(card.getByRole('status')).toContainText('applied for this month');
            await card.locator('details summary').click();
            await page.screenshot({ path: path.join(OUT, `usage-applied-history-${width}-${dark ? 'dark' : 'light'}.png`) });
            await card.getByRole('button', { name: 'Use normal limit now', exact: true }).click();
            await expect(card.getByRole('status')).toContainText('Normal capacity limit restored.');
            await expect(card.getByRole('button', { name: 'Use 4.8 kW this month', exact: true })).toBeVisible();
            expect(await page.evaluate(() => (window as unknown as {
              Homey: { __stub: { getSetting: (key: string) => unknown } };
            }).Homey.__stub.getSetting('capacity_limit_kw'))).toBe(5);
          }
          await page.getByRole('tab', { name: 'Settings', exact: true }).click();
          await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
          await expect(page.locator('#monthly-capacity-limits-mount')).toBeVisible();
          await page.locator('#monthly-capacity-limits-mount').scrollIntoViewIfNeeded();
          await expect.poll(() => page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          )).toBe(true);
          await page.screenshot({
            path: path.join(OUT, `limits-${variant}-${width}-${dark ? 'dark' : 'light'}.png`),
          });
        } finally { await context.close(); }
      }
    });
  }
}


for (const width of [320, 480]) {
  for (const dark of [false, true]) {
    test(`hourly history recovery ${width} ${dark ? 'dark' : 'light'}`, async ({ browser, baseURL }) => {
      test.skip(process.env.PELS_CAPTURE_HISTORY_RECOVERY !== '1', 'Local design capture only');
      fs.mkdirSync(OUT, { recursive: true });
      const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 },
        ...(dark ? { isMobile: true, hasTouch: true } : {}),
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await page.clock.setFixedTime(NOW);
        await seedMonthlyCapacity(page, false);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="advanced"]').click();
        const management = page.locator('.settings-collapse').filter({
          has: page.getByText('Data management', { exact: true }),
        });
        await management.locator('summary').click();
        await expect(page.locator('#power-history-recovery')).toBeVisible();
        await expect(page.locator('#power-history-recovery-status')).toContainText('Recovered 135 missing hours');
        await page.locator('#power-history-recovery').scrollIntoViewIfNeeded();
        await expect.poll(() => page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        )).toBe(true);
        await page.screenshot({ path: path.join(OUT, `history-recovery-${width}-${dark ? 'dark' : 'light'}.png`) });
      } finally { await context.close(); }
    });
  }
}
