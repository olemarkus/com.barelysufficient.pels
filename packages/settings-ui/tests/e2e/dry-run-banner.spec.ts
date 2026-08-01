import { expect, test, type Page } from './fixtures/test';
import { gotoApp } from './fixtures/homes';

/* -------------------------------------------------------------------------- *
 * The simulation banner sits on every tab, and its action is fixed-width, so in
 * a flex row it steals the text column and towers the message one word per
 * line. The stacked layout that fixes this used to be bounded at 360 px and
 * scoped to the Main variant, which left the widest wording towering from
 * 361 px up to ~430 px — taller at 361 px than at 320 px. The Playwright
 * projects only run 320 and 480, so that band was never asserted; this spec is
 * the guard for it.
 * -------------------------------------------------------------------------- */

// 361 and 393/412 are the previously-failing band (Pixel/iPhone-class widths).
const WIDTHS = [320, 361, 393, 412, 480];

/** Rendered line count of the banner copy, from its own box and line-height. */
const bannerTextLines = (page: Page): Promise<number> => page.evaluate(() => {
  const el = document.querySelector('#dry-run-banner-text');
  if (!el) throw new Error('banner text missing');
  const style = getComputedStyle(el);
  const parsed = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsed)
    ? parsed
    : Number.parseFloat(style.fontSize) * 1.2;
  return Math.round(el.getBoundingClientRect().height / lineHeight);
});

const bannerHeight = (page: Page): Promise<number> => page.evaluate(() => {
  const el = document.querySelector('#dry-run-banner');
  if (!el) throw new Error('banner missing');
  return el.getBoundingClientRect().height;
});

/**
 * The banner resolves its home scope once, during boot, so the roster has to be
 * in place before the page loads — seeding it afterwards leaves the banner on
 * the single-home copy.
 */
const seedMeterAreaBeforeBoot = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const stubWindow = window as unknown as {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: {
        ...(existing.settings ?? {}),
        power_source: 'homey_energy',
        capacity_dry_run: true,
        homes_config: {
          activationVersion: 1,
          subHomes: [{
            homeId: 'h_11111111',
            name: 'Rental unit',
            rootZoneId: 'z_rental',
            meterDeviceId: 'dev_rental_meter',
          }],
        },
      },
    };
  });
};

test('the Main-scoped simulation banner stays readable across the supported widths', async ({
  page,
}) => {
  await seedMeterAreaBeforeBoot(page);
  await gotoApp(page);

  const banner = page.locator('#dry-run-banner');
  await expect(banner).toBeVisible();
  // A meter area exists, so the banner carries the wider Main-scoped wording.
  await expect(banner).toHaveAttribute('data-home-scope', 'main');

  const heights: Record<number, number> = {};
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(banner).toBeVisible();

    const lines = await bannerTextLines(page);
    expect(lines, `banner copy towered into ${lines} lines at ${width} px`)
      .toBeLessThanOrEqual(3);

    // The action must stay reachable, not pushed out of the banner box.
    await expect(page.locator('#simulation-disable-button')).toBeVisible();
    heights[width] = await bannerHeight(page);
  }

  // The regression signature was an inverted cliff: a WIDER viewport produced a
  // TALLER banner because the stacked layout stopped applying above 360 px.
  for (const width of WIDTHS.filter((candidate) => candidate > 320)) {
    expect(
      heights[width],
      `banner is taller at ${width} px (${heights[width]}) than at 320 px (${heights[320]})`,
    ).toBeLessThanOrEqual(heights[320]);
  }
});
