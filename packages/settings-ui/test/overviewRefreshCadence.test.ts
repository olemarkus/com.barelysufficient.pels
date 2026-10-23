import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes.ts';
import { emitHomeyEvent, installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';

// What an open Overview and a hidden Smart tasks page cost in Homey calls while
// the WebView sits idle. Every call counts against the Homey cloud's per-Homey
// rate limit when the page is opened remotely, so the plan and the smart-task
// history ride their own pushes and settings events; the 30 s status poll
// re-reads them only as a slow safety net.

const NOW_MS = Date.now();
const POLL_MS = 30 * 1000;

const PLAN_SNAPSHOT = {
  meta: buildPlanMeta({
    gridImportLimitKw: null,
    gridImportTargetKw: null,
    totalKw: 1.2,
    softLimitKw: 5,
    capacitySoftLimitKw: 5,
    hardCapLimitKw: 8,
  }),
  devices: [],
  rescuableDeviceIds: [],
};

const buildDom = (visiblePanel: 'overview' | 'deadlines' | 'devices'): void => {
  const hiddenUnless = (panel: string): string => (panel === visiblePanel ? '' : ' hidden');
  document.body.innerHTML = `
    <section class="panel${hiddenUnless('overview')}" id="overview-panel" data-panel="overview">
      <div id="plan-redesign-surface"></div>
    </section>
    <section class="panel${hiddenUnless('deadlines')}" id="deadlines-panel" data-panel="deadlines">
      <div id="deadlines-list-root"></div>
      <div id="deadlines-history-root"></div>
    </section>
    <section class="panel${hiddenUnless('devices')}" id="devices-panel" data-panel="devices"></section>
    <div id="toast"></div>
  `;
};

const getCount = (homey: MockHomeyClient, uri: string): number => (
  homey.api.mock.calls.filter(([method, calledUri]) => method === 'GET' && calledUri === uri).length
);

describe('Overview refresh cadence', () => {
  let homey: MockHomeyClient;

  const install = async (visiblePanel: 'overview' | 'deadlines' | 'devices') => {
    buildDom(visiblePanel);
    homey = installHomeyMock({
      settings: {
        pels_status: { lastPowerUpdate: NOW_MS, powerFreshnessState: 'fresh' },
      },
      uiState: { plan: PLAN_SNAPSHOT, starvationRescueCreate: { ok: true, runsCurrentHour: true } },
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey as never);
    // Booted: Overview's activation has loaded the device list.
    const { state } = await import('../src/ui/state.ts');
    state.devicesLoaded = true;
    const realtime = await import('../src/ui/realtime.ts');
    realtime.initRealtimeListeners();
    homey.api.mockClear();
    return realtime;
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    document.body.innerHTML = '';
  });

  it('reads only the status on most polls and the plan and history on every fourth', async () => {
    const { startStaleDataRefreshInterval } = await install('overview');
    startStaleDataRefreshInterval();

    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    // One status read per poll, shared by the stale-data status and the hero's power.
    expect(getCount(homey, SETTINGS_UI_POWER_PATH)).toBe(3);
    expect(getCount(homey, SETTINGS_UI_PLAN_PATH)).toBe(0);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(0);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(getCount(homey, SETTINGS_UI_POWER_PATH)).toBe(4);
    expect(getCount(homey, SETTINGS_UI_PLAN_PATH)).toBe(1);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(1);
  });

  it('reads only the status while the Overview is hidden', async () => {
    const { startStaleDataRefreshInterval } = await install('devices');
    startStaleDataRefreshInterval();

    await vi.advanceTimersByTimeAsync(4 * POLL_MS);
    expect(getCount(homey, SETTINGS_UI_POWER_PATH)).toBe(4);
    expect(getCount(homey, SETTINGS_UI_PLAN_PATH)).toBe(0);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(0);
  });

  it('re-reads the plan for a plan setting without the history, and only on a visible Overview', async () => {
    await install('overview');
    emitHomeyEvent(homey, 'settings.set', 'capacity_priorities');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_PLAN_PATH)).toBe(1);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(0);

    document.getElementById('overview-panel')?.classList.add('hidden');
    emitHomeyEvent(homey, 'settings.set', 'capacity_priorities');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_PLAN_PATH)).toBe(1);
  });

  it('reads the smart-task history when a task\'s active plan changes on a visible Overview', async () => {
    await install('overview');
    emitHomeyEvent(homey, 'settings.set', 'deferred_objective_active_plans');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(1);

    document.getElementById('overview-panel')?.classList.add('hidden');
    emitHomeyEvent(homey, 'settings.set', 'deferred_objective_active_plans');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(1);
  });

  it('gates the rescue chip from a pushed plan without a read of its own', async () => {
    await install('overview');
    emitHomeyEvent(homey, 'plan_updated', { ...PLAN_SNAPSHOT, rescuableDeviceIds: ['heater-1'] });
    await vi.advanceTimersByTimeAsync(0);

    const { isStarvationRescuable } = await import('../src/ui/starvationRescue.ts');
    expect(isStarvationRescuable('heater-1')).toBe(true);
    expect(homey.api).not.toHaveBeenCalled();
  });

  it('lets a rescued device offer the rescue again after its task ended while the Overview was hidden', async () => {
    await install('devices');
    const rescue = await import('../src/ui/starvationRescue.ts');
    rescue.applyPlanRescueGate(['heater-1']);
    // The success toast dwells on a timer.
    const created = rescue.createStarvationRescue('heater-1');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(created).resolves.toEqual({ ok: true, runsCurrentHour: true });
    expect(rescue.isStarvationRescuable('heater-1')).toBe(false);

    // While the owner is elsewhere: the task runs (the plan stops listing the
    // device), ends, and the device is held back again.
    emitHomeyEvent(homey, 'plan_updated', PLAN_SNAPSHOT);
    emitHomeyEvent(homey, 'plan_updated', { ...PLAN_SNAPSHOT, rescuableDeviceIds: ['heater-1'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rescue.isStarvationRescuable('heater-1')).toBe(true);
  });

  it('reads the device list, the meter areas and the car list once each for a devices_updated push', async () => {
    await install('overview');
    const { refreshHomeBadges } = await import('../src/ui/homeBadges.ts');
    await refreshHomeBadges();
    homey.api.mockClear();

    emitHomeyEvent(homey, 'devices_updated', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_DEVICES_PATH)).toBe(1);
    expect(getCount(homey, SETTINGS_UI_RECOMMENDATION_CARS_PATH)).toBe(1);
    // The push follows a Homey zone move too, which moves meter-area membership
    // without a settings write; the task history changes on its own events.
    expect(getCount(homey, SETTINGS_UI_HOMES_PATH)).toBe(1);
    expect(getCount(homey, SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH)).toBe(0);
  });

  it('leaves a hidden Smart tasks list to its activation and refreshes a visible one', async () => {
    await install('overview');
    emitHomeyEvent(homey, 'settings.set', 'deferred_objective.heater-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_BOOTSTRAP_PATH)).toBe(0);

    document.getElementById('overview-panel')?.classList.add('hidden');
    document.getElementById('deadlines-panel')?.classList.remove('hidden');
    emitHomeyEvent(homey, 'settings.set', 'deferred_objective.heater-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(getCount(homey, SETTINGS_UI_BOOTSTRAP_PATH)).toBe(1);
  });
});
