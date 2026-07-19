// SDK-boundary e2e for the multi-home v1 smart-task scope gate, driven and
// observed ONLY through the Homey SDK seams: membership is configured via
// `homes_config` / `device_home_assignments` settings writes and the zone
// route + device zone payloads; the observation is the flow card's thrown
// error / return value, the card's device autocomplete, and the persisted
// per-key objective settings. Nothing internal is mocked or read — the
// app-method lanes (create/rescue/candidates/starved list/relocation) live in
// the integration-tier sibling `test/integration/smartTaskSubHomeGateApp.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockZones } from '../mocks/homey';
import { cleanupApps } from '../utils/appTestUtils';
import { initAppWithSubHome, SUB_HOME_ZONES } from '../utils/smartTaskSubHomeHarness';
import { readAllObjectives } from '../../lib/objectives/deferredObjectives';
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from '../../packages/shared-domain/src/objectiveWriteStrings';

describe('smart-task sub-home gate (SDK boundary)', () => {
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

  it('flow card set_temperature_deadline on a sub-home device throws the clear scope error; autocomplete excludes it', async () => {
    await initAppWithSubHome();

    const runListener = mockHomeyInstance.flow._actionCardListeners.set_temperature_deadline;
    expect(runListener).toBeTypeOf('function');
    await expect(runListener({
      device: { id: 'heater-sub' },
      target_c: 60,
      ready_by: '23:59',
    })).rejects.toThrow(SMART_TASK_SUB_HOME_UNAVAILABLE);
    // The rejected card left nothing behind.
    expect(readAllObjectives(mockHomeyInstance.settings).objectivesByDeviceId['heater-sub'])
      .toBeUndefined();

    // The device picker never offers the sub-home device for a new task.
    const autocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners
      .set_temperature_deadline?.device;
    expect(autocomplete).toBeTypeOf('function');
    const options = await autocomplete('');
    const optionIds = options.map((option: { id: string }) => option.id);
    expect(optionIds).toContain('heater-main');
    expect(optionIds).not.toContain('heater-sub');

    // The main-home device still runs the card end-to-end.
    await expect(runListener({
      device: { id: 'heater-main' },
      target_c: 60,
      ready_by: '23:59',
    })).resolves.toBe(true);
    expect(readAllObjectives(mockHomeyInstance.settings).objectivesByDeviceId['heater-main'])
      .toMatchObject({ enabled: true, kind: 'temperature', targetTemperatureC: 60 });
  });
});
