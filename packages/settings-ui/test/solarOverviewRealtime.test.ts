import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitHomeyEvent, installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { initRealtimeListeners } from '../src/ui/realtime.ts';
import { refreshPlan } from '../src/ui/planRedesign.ts';
import { refreshOverviewPlanWithRescueGate } from '../src/ui/overviewRescueGate.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';

// Regression pin for the status-only `power_updated` stomp: every runtime
// power push is status-only (`emitSettingsUiPowerUpdatedForApp` sends
// `tracker: null`), and the old cache patch wrote that null over the cached
// full tracker — so the next Overview open (`refreshOverviewPlanWithRescueGate`
// → `refreshPlan` → /ui_power read model) resolved no solar input and the
// "Solar now" subline vanished until the 30 s periodic refetch healed it.
// The patch must preserve the cached tracker; only status/heartbeat move.

const NOW_MS = Date.now();

const SOLAR_TRACKER = {
  buckets: { '2026-06-15T10:00:00.000Z': 0.4 },
  lastPowerW: -2100,
  lastGenerationW: 3200,
  lastTimestamp: NOW_MS,
};

// Minimal but numerically consistent hero meta (net export → negative total).
const PLAN_SNAPSHOT = {
  meta: buildPlanMeta({
    totalKw: -2.1,
    softLimitKw: 2.3,
    capacitySoftLimitKw: 2.3,
    headroomKw: 4.4,
    hardCapLimitKw: 8,
  }),
  devices: [],
};

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const solarSubline = () => document.querySelector('#plan-hero-solar-now');

describe('Overview "Solar now" across status-only power pushes', () => {
  let homey: MockHomeyClient;

  beforeEach(() => {
    document.body.innerHTML = '<div id="plan-redesign-surface"></div>';
    homey = installHomeyMock({
      settings: {
        power_tracker_state: SOLAR_TRACKER,
        // The RAW blob: this is the persisted settings key, and the mock's
        // buildUiPower classifies it exactly like the real producer — seeding
        // the wire shape here would double-wrap the union.
        pels_status: { lastPowerUpdate: NOW_MS, powerFreshnessState: 'fresh' },
      },
      uiState: { plan: PLAN_SNAPSHOT },
    });
    setHomeyClient(homey as never);
    initRealtimeListeners();
  });

  afterEach(() => {
    setHomeyClient(null);
    document.body.innerHTML = '';
  });

  it('keeps the subline on an Overview refresh after a status-only push', async () => {
    await refreshPlan();
    expect(solarSubline()?.textContent).toBe('Solar now 3.2\u00A0kW — 1.1\u00A0kW at home, 2.1\u00A0kW exported');

    // Runtime-shaped status-only push: no tracker property at all — the
    // emitter omits it and the WebView preserves its cached one.
    emitHomeyEvent(homey, 'power_updated', {
      status: { state: 'live', status: { lastPowerUpdate: NOW_MS + 10_000, powerFreshnessState: 'fresh' } },
      readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 },
    });
    await flushAsync();
    // The push itself must not tear the line down…
    expect(solarSubline()?.textContent).toContain('Solar now');

    // …and the Overview-open path (which re-reads the /ui_power read model)
    // must still resolve the solar input from the preserved cached tracker.
    await refreshOverviewPlanWithRescueGate();
    await flushAsync();
    expect(solarSubline()?.textContent).toBe('Solar now 3.2\u00A0kW — 1.1\u00A0kW at home, 2.1\u00A0kW exported');
  });
});
