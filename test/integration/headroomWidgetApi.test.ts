/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { getHeadroom } from '../../widgets/headroom/src/api';
import { createPlanStatusRegistry } from '../../lib/plan/planStatusRegistry';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';

// The widget API handler runs app-side, so it classifies the main home's
// published status against the live tracker latch — the same evidence the
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

  // The app shell the widget handler sees: a tracker and the registry with
  // the main home's status published (or none, on `status: null`).
  const appWith = (powerTracker: unknown, status: Record<string, unknown> | null = blob): unknown => {
    const planStatuses = createPlanStatusRegistry();
    if (status !== null) planStatuses.publish(MAIN_HOME_ID, status as never);
    return { powerTracker, planStatuses };
  };
  const createContext = (app: unknown) => ({ homey: { app } });

  it('serves a ready payload while the live tracker holds a measurement', async () => {
    const context = createContext(appWith({ lastPowerW: 5200, lastTimestamp: Date.now() }));
    await expect(getHeadroom(context)).resolves.toMatchObject({
      state: 'ready',
      currentKw: 3.2,
      hourBudgetKw: 7,
      shedCount: 2,
      stale: false,
    });
  });

  it('renders empty — never the published status as current — while the latch is gone', async () => {
    // A cleared latch (in-place meter swap / corrupt restore) with a status
    // only seconds old: aging alone would still present it as live.
    const context = createContext(appWith({ buckets: {} }));
    await expect(getHeadroom(context)).resolves.toMatchObject({ state: 'empty' });
  });

  it('renders empty while the home is measured but has published no status yet', async () => {
    const context = createContext(appWith({ lastPowerW: 5200, lastTimestamp: Date.now() }, null));
    await expect(getHeadroom(context)).resolves.toMatchObject({ state: 'empty' });
  });

  it('classifies an unreadable app shell as no measurement, not as live', async () => {
    await expect(getHeadroom(createContext(undefined))).resolves.toMatchObject({ state: 'empty' });
  });

  it('still ages a measured home status into the not-current presentation', async () => {
    const context = createContext(appWith(
      { lastPowerW: 5200, lastTimestamp: Date.now() - 120_000 },
      { ...blob, lastPowerUpdate: Date.now() - 120_000 },
    ));
    await expect(getHeadroom(context)).resolves.toMatchObject({ state: 'ready', stale: true });
  });
});
