// Integration-tier app-lane battery for the multi-home v1 smart-task scope
// gate (moved from the e2e spec per the repo test taxonomy: these cases call
// app methods directly and sanity-read the membership service, so they are
// one-layer app-surface tests, not SDK-boundary observations). Membership is
// still DRIVEN through the SDK seams (`homes_config` /
// `device_home_assignments` settings writes through the real serialized
// settings handler); the real diagnostics service is fed through its
// production observe API for the starved-list case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockZones } from '../mocks/homey';
import { cleanupApps } from '../utils/appTestUtils';
import {
  initAppWithSubHome,
  rescueCandidate,
  SUB_HOME_ZONES,
  settleAsyncSeams,
  tempCandidate,
} from '../utils/smartTaskSubHomeHarness';
import { readAllObjectives } from '../../lib/objectives/deferredObjectives';
import { DEVICE_HOME_ASSIGNMENTS } from '../../lib/utils/settingsKeys';
import { updateSettingsUiSmartTask } from '../../setup/settingsUiSmartTaskApi';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

describe('smart-task sub-home gate (app lanes)', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
    setMockZones({ ...SUB_HOME_ZONES });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    setMockZones(null);
    vi.clearAllTimers();
  });

  it('rejects every app write lane for the sub-home device and keeps the main-home device fully working', async () => {
    const app = await initAppWithSubHome({ assertMembership: true });

    // Widget create lane.
    expect(app.createDeferredObjective('heater-sub', tempCandidate(60)))
      .toEqual({ ok: false, reason: 'device_in_sub_home' });
    // Rescue lane (funnels through the same create engine).
    expect(app.rescueDeviceWithBudgetExemption('heater-sub', rescueCandidate(60)))
      .toEqual({ ok: false, reason: 'device_in_sub_home' });
    // Nothing persisted for the sub-home device.
    expect(readAllObjectives(mockHomeyInstance.settings).objectivesByDeviceId['heater-sub'])
      .toBeUndefined();

    // Candidate list excludes the sub-home device but keeps the main one.
    expect(app.getCreateSmartTaskCandidateDevices().map((device: TargetDeviceSnapshot) => device.id))
      .toEqual(['heater-main']);

    // Main-home device: unaffected — the create persists.
    expect(app.createDeferredObjective('heater-main', tempCandidate(60))).toEqual({ ok: true });
    expect(readAllObjectives(mockHomeyInstance.settings).objectivesByDeviceId['heater-main'])
      .toMatchObject({ enabled: true, kind: 'temperature', targetTemperatureC: 60 });
  });

  it('the starved rescue list excludes sub-home devices (the rescue is a main-home smart-task create)', async () => {
    const app = await initAppWithSubHome({ assertMembership: true });
    // Feed the REAL diagnostics service through its production observe API:
    // both heaters budget-starved past the 15-minute entry latency. The service,
    // the rescue-entry computation, and the app's join+filter all run for real.
    const observation = (deviceId: string, name: string) => ({
      deviceId,
      name,
      includeDemandMetrics: true,
      unmetDemand: true,
      blockCause: 'headroom',
      targetDeficitActive: true,
      desiredStateSummary: '65.0C',
      appliedStateSummary: '50.0C',
      eligibleForStarvation: true,
      currentTemperatureC: 50,
      intendedNormalTargetC: 65,
      commandedTargetC: 50,
      targetStepC: 0.5,
      pelsCommandsTurnOffShed: false,
      suppressionState: 'counting',
      countingCause: 'daily_budget',
      pauseReason: null,
      observationFresh: true,
    });
    const start = Date.now();
    for (const offsetMinutes of [0, 9, 16]) {
      app.deviceDiagnosticsService.observePlanSample({
        nowTs: start + offsetMinutes * 60 * 1000,
        observations: [
          observation('heater-sub', 'Cabin heater'),
          observation('heater-main', 'Hall heater'),
        ],
      });
    }
    const rescueIds = app.getStarvedRescueDevices().map((device: { deviceId: string }) => device.deviceId);
    expect(rescueIds).toEqual(['heater-main']);
  });

  it('a task created while main-home stays clearable after the device is pinned into the sub-home', async () => {
    const app = await initAppWithSubHome({ assertMembership: true });

    expect(app.createDeferredObjective('heater-main', tempCandidate(55))).toEqual({ ok: true });

    // Relocate the device by pin — the same SDK settings seam a user's
    // assignment edit rides.
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, {
      'heater-sub': 'h_cabin',
      'heater-main': 'h_cabin',
    });
    await settleAsyncSeams();
    expect(app.homeMembership.getHomeIdForDevice('heater-main')).toBe('h_cabin');

    // Editing (a re-create) is now refused with the typed reason…
    expect(app.createDeferredObjective('heater-main', tempCandidate(70)))
      .toEqual({ ok: false, reason: 'device_in_sub_home' });
    // …including through the settings-UI edit lane (its own validation path:
    // task-exists gate passes, then the create engine rejects and the lane's
    // reason mapper must keep the typed reason for the editor's copy).
    expect(updateSettingsUiSmartTask({
      homey: mockHomeyInstance as never,
      body: { deviceId: 'heater-main', kind: 'temperature', target: 70, readyByLocalTime: '23:59' },
    })).toEqual({ ok: false, reason: 'device_in_sub_home' });
    // …but clearing the existing task still works: the cancel lane is ungated.
    expect(app.cancelDeferredObjective('heater-main')).toEqual({ ok: true });
    expect(readAllObjectives(mockHomeyInstance.settings).objectivesByDeviceId['heater-main'])
      .toBeUndefined();
  });
});
