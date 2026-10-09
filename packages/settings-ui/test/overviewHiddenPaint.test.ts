import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitHomeyEvent, installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { initRealtimeListeners } from '../src/ui/realtime.ts';
import { paintOverviewIfOwed, refreshPlan } from '../src/ui/planRedesign.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

// A hidden Overview keeps what it paints from current but paints nothing:
// `power_updated` pushes and the 1 s live tick would rebuild DOM nobody sees.
// Opening the tab (`paintOverviewIfOwed`, called by tab navigation) pays the
// owed paint and restarts the tick.

const countdownDevice = (endsAtMs: number) => {
  const device = uiDeviceFixture({ id: 'heater', currentState: 'off', plannedState: 'shed' }, false, 0);
  return { ...device, status: { ...device.status, reason: {
    text: 'Waiting after limiting a device (60s)',
    countdown: { kind: 'in_text' as const, endsAtMs, totalSec: 60,
      prefix: 'Waiting after limiting a device (', suffix: ')' },
  } } };
};

const planWith = (devices: unknown[]) => ({
  meta: buildPlanMeta({ totalKw: 1.2, softLimitKw: 5, capacitySoftLimitKw: 5, hardCapLimitKw: 8 }),
  devices,
});

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const surface = (): HTMLElement => {
  const element = document.getElementById('plan-redesign-surface');
  if (!element) throw new Error('expected the plan surface');
  return element;
};

const panel = (): HTMLElement => {
  const element = document.getElementById('overview-panel');
  if (!element) throw new Error('expected the Overview panel');
  return element;
};

const SKELETON = '<span class="skeleton">loading</span>';

const mountOverview = (hidden: boolean): void => {
  document.body.innerHTML = `<section id="overview-panel"${hidden ? ' class="hidden"' : ''}>`
    + `<div id="plan-redesign-surface">${SKELETON}</div></section>`;
};

describe('Overview paint while its tab is hidden', () => {
  let homey: MockHomeyClient;

  const install = (plan: unknown): void => {
    homey = installHomeyMock({ uiState: { plan } });
    setHomeyClient(homey as never);
    initRealtimeListeners();
  };

  afterEach(() => {
    vi.useRealTimers();
    setHomeyClient(null);
    document.body.innerHTML = '';
  });

  describe('a hidden panel', () => {
    beforeEach(() => {
      mountOverview(true);
      install(planWith([]));
    });

    it('paints nothing on a refresh or a power push, then paints once the tab opens', async () => {
      await refreshPlan();
      emitHomeyEvent(homey, 'power_updated', {
        status: { state: 'live', status: { lastPowerUpdate: Date.now(), powerFreshnessState: 'fresh' } },
        readings: { state: 'received', lastPowerUpdateMs: Date.now() },
      });
      await flushAsync();
      expect(surface().innerHTML).toBe(SKELETON);

      panel().classList.remove('hidden');
      paintOverviewIfOwed();

      expect(surface().innerHTML).not.toBe(SKELETON);
      expect(surface().childElementCount).toBeGreaterThan(0);
    });
  });

  it('stops the live tick while hidden and restarts it when the tab opens', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mountOverview(false);
    install(planWith([countdownDevice(Date.now() + 60_000)]));

    await refreshPlan();
    const ticking = vi.getTimerCount();
    expect(ticking).toBeGreaterThan(0);

    panel().classList.add('hidden');
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(ticking - 1);

    panel().classList.remove('hidden');
    paintOverviewIfOwed();
    expect(vi.getTimerCount()).toBe(ticking);
  });
});
