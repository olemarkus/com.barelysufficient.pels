/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { getHeadroom } from '../../widgets/headroom/src/api';

// The widget API handler runs app-side, so it classifies the persisted
// `pels_status` blob against the live tracker latch — the same evidence the
// plan-build gate and the ui_power composers use (`classifyPowerStatusRead`).
// Timestamp aging alone cannot see a latch cleared moments after a fresh
// sample, so this seam is what keeps a gated home from presenting the previous
// run's numbers as current during the first 90 seconds.
describe('headroom widget api (app-side classification)', () => {
  const blob = {
    headroomKw: 3.8,
    hourlyLimitKw: 7,
    devicesOff: 2,
    priceLevel: 'cheap',
    lastPowerUpdate: Date.now() - 5_000,
  };

  const createContext = (app: unknown, settings: Record<string, unknown>) => ({
    homey: {
      app,
      settings: { get: (key: string) => settings[key] },
    },
  });

  it('serves a ready payload while the live tracker holds a measurement', async () => {
    const context = createContext({ powerTracker: { lastPowerW: 5200, lastTimestamp: Date.now() } }, {
      pels_status: blob,
    });
    await expect(getHeadroom(context)).resolves.toMatchObject({
      state: 'ready',
      currentKw: 3.2,
      hourBudgetKw: 7,
      shedCount: 2,
      stale: false,
    });
  });

  it('renders empty — never the stored blob as current — while the latch is gone', async () => {
    // A cleared latch (in-place meter swap / corrupt restore) with a blob only
    // seconds old: aging alone would still present it as live.
    const settings: Record<string, unknown> = { pels_status: blob };
    const context = createContext({ powerTracker: { buckets: {} } }, settings);
    await expect(getHeadroom(context)).resolves.toMatchObject({ state: 'empty' });
    // The stored blob is preserved — the read changed only the claim.
    expect(settings.pels_status).toEqual(blob);
  });

  it('classifies an unreadable app shell as no measurement, not as live', async () => {
    await expect(getHeadroom(createContext(undefined, { pels_status: blob })))
      .resolves.toMatchObject({ state: 'empty' });
  });

  it('still ages a measured home blob into the not-current presentation', async () => {
    const context = createContext({ powerTracker: { lastPowerW: 5200, lastTimestamp: Date.now() - 120_000 } }, {
      pels_status: { ...blob, lastPowerUpdate: Date.now() - 120_000 },
    });
    await expect(getHeadroom(context)).resolves.toMatchObject({ state: 'ready', stale: true });
  });
});
