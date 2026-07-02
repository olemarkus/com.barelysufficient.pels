import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  const setup = (dryRunSetting: boolean, priorState: boolean) => {
    homey = installHomeyMock({
      settings: {
        [CAPACITY_DRY_RUN]: dryRunSetting,
        [CAPACITY_LIMIT_KW]: 10,
        [CAPACITY_MARGIN_KW]: 0.2,
        [POWER_SOURCE]: 'flow',
      },
    });
    setHomeyClient(homey as never);
    state.dryRun = priorState;
    initRealtimeListeners();
    // Register the counting renderer last so it wins over planRedesign's real one.
    registerPlanSurfaceRenderer(() => { renders += 1; });
  };

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
});
