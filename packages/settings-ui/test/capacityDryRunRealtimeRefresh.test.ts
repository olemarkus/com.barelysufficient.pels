import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitHomeyEvent, installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { initRealtimeListeners } from '../src/ui/realtime.ts';
import { registerPlanSurfaceRenderer } from '../src/ui/planSurfaceRefresh.ts';
import { state } from '../src/ui/state.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  POWER_SOURCE,
} from '../../contracts/src/settingsKeys.ts';
import { loadCapacitySettings, saveSimulationModeSettings } from '../src/ui/capacity.ts';

vi.mock('../src/ui/toast.ts', () => ({
  ERROR_DURATION_MS: 6000,
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

// An external simulation-mode change (a second open WebView, or a Flow) reaches
// the UI as a `settings.set` for `capacity_dry_run`, routed through the realtime
// handler to `loadCapacitySettings`. That path must re-render the Overview so the
// hero decision sentence and device-card "(simulation)" framing flip with the
// banner — not linger stale until the next plan/power push.

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

describe('external capacity_dry_run settings.set refreshes the plan surface', () => {
  let homey: MockHomeyClient;
  let renders: number;

  beforeEach(() => {
    document.body.innerHTML = '<div id="plan-redesign-surface"></div>';
    renders = 0;
    // Registering after `initRealtimeListeners` (which imports planRedesign and
    // registers its real doRender) would be overwritten; register the spy in the
    // setup helper instead, after listeners are wired.
  });

  afterEach(() => {
    setHomeyClient(null);
    registerPlanSurfaceRenderer(() => {});
    document.body.innerHTML = '';
  });

  const setup = (
    dryRunSetting: boolean | undefined,
    priorState: boolean,
    mainDryRunEffective?: boolean,
    mainCapacityScalars?: { limitKw: number; marginKw: number },
  ) => {
    homey = installHomeyMock({
      settings: {
        ...(dryRunSetting === undefined ? {} : { [CAPACITY_DRY_RUN]: dryRunSetting }),
        [CAPACITY_LIMIT_KW]: 10,
        [CAPACITY_MARGIN_KW]: 0.2,
        [POWER_SOURCE]: 'flow',
      },
      ...(typeof mainDryRunEffective === 'boolean'
        ? {
          uiState: {
            power: {
              tracker: null,
              status: null,
              heartbeat: null,
              mainDryRunEffective,
              ...(mainCapacityScalars ? { mainCapacityScalars } : {}),
            },
          },
        }
        : {}),
    });
    setHomeyClient(homey as never);
    state.dryRun = priorState;
    initRealtimeListeners();
    // Register the counting renderer last so it wins over planRedesign's real one.
    registerPlanSurfaceRenderer(() => { renders += 1; });
  };

  it('uses the simulation boot default before any dry-run value has resolved', async () => {
    setup(undefined, false);

    emitHomeyEvent(homey, 'settings.unset', CAPACITY_DRY_RUN);
    await flushAsync();

    expect(state.dryRun).toBe(true);
    expect(renders).toBeGreaterThan(0);
  });

  it('uses the running Main posture after a reload when the persisted key is absent', async () => {
    setup(undefined, true, false);

    await loadCapacitySettings();

    expect(state.dryRun).toBe(false);
    expect(renders).toBeGreaterThan(0);
  });

  it('preserves retained Main limit and margin when their persisted keys are absent', async () => {
    setup(undefined, true, false, { limitKw: 12, marginKw: 0.4 });
    delete homey.__settingsStore[CAPACITY_LIMIT_KW];
    delete homey.__settingsStore[CAPACITY_MARGIN_KW];

    await loadCapacitySettings();
    await saveSimulationModeSettings(false);

    expect(homey.set).toHaveBeenCalledWith(CAPACITY_LIMIT_KW, 12, expect.any(Function));
    expect(homey.set).toHaveBeenCalledWith(CAPACITY_MARGIN_KW, 0.4, expect.any(Function));
  });

  it('re-renders when simulation flips off in another WebView', async () => {
    setup(false, true); // the setting is now off; this UI still thinks it is on
    emitHomeyEvent(homey, 'settings.set', CAPACITY_DRY_RUN);
    await flushAsync();
    expect(state.dryRun).toBe(false);
    expect(renders).toBeGreaterThan(0);
  });

  it('does not re-render when the dry-run value is unchanged', async () => {
    setup(true, true); // the setting is on; this UI already has it on
    emitHomeyEvent(homey, 'settings.set', CAPACITY_DRY_RUN);
    await flushAsync();
    expect(state.dryRun).toBe(true);
    expect(renders).toBe(0);
  });

  it('keeps the runtime last-good posture when the setting is cleared externally', async () => {
    setup(false, false);
    emitHomeyEvent(homey, 'settings.set', CAPACITY_DRY_RUN);
    await flushAsync();
    delete homey.__settingsStore[CAPACITY_DRY_RUN];

    emitHomeyEvent(homey, 'settings.unset', CAPACITY_DRY_RUN);
    await flushAsync();

    expect(state.dryRun).toBe(false);
    expect(renders).toBe(0);
  });
});
