/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { CreateSmartTaskCandidateDevice } from '../../packages/contracts/src/widgetHostApi';
import { getDeviceWidget } from '../../widgets/device/src/api';
import { buildDeviceWidgetChoices } from '../../widgets/device/src/deviceWidgetPayload';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { resolveActivePlanFixtures, type ActivePlanFixture } from '../helpers/activePlanFixtures';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const STATUS: DeviceStatus = {
  cardKind: 'temperature', kind: 'held', tone: 'held', label: 'Limited', powerText: '0.0 kW',
  powerVariant: 'live', factText: '54.0 °C · target 65 °C', reading: { kind: 'temperature', currentC: 54, targetC: 65 },
  reason: { text: 'Waiting to resume — 0.8 kW more needed' }, rail: null, limited: true, wouldLimit: false,
  canEaseOff: false, controlOffDrawing: false, holdCause: null,
};

const planDevice = (id: string, name: string): SettingsUiPlanDeviceSnapshot => ({
  id, name, controllable: true, available: true, isEvCharger: false, boostActive: false, status: STATUS,
});

// A thermostat the creation gate accepts: a complete temperature observation.
const heater: CreateSmartTaskCandidateDevice = {
  available: true, id: 'heater', name: 'Water heater', targets: [],
  isEvCharger: false, binaryControllable: false,
  temperature: {
    currentTemperature: 54,
    target: { id: 'target_temperature', value: 65, unit: '°C', min: 20, max: 85, step: 1 },
    intendedTargetC: 65,
  },
};

const plan: ActivePlanFixture = {
  liveCompletion: { kind: 'unavailable' },
  deviceId: 'heater', deviceName: 'Water heater', objectiveKind: 'temperature', targetValue: 65,
  deadlineAtMs: NOW + 5 * HOUR, startedAtMs: NOW - HOUR, pending: false, objectiveSignature: 'sig', original: null,
  latest: {
    revision: 1, revisedAtMs: NOW, computedFromPricesUpTo: null, reason: 'flow_card',
    hours: [{ startsAtMs: NOW + 2 * HOUR, plannedKWh: 1 }], energyNeededKWh: 1, planStatus: 'on_track',
  },
};

const read = (host: object, deviceId: unknown) => getDeviceWidget({
  homey: { app: pelsHostDouble(host), clock: { getTimezone: () => 'UTC' } }, body: { deviceId },
});

describe('Device widget read', () => {
  it('reads as starting before the first plan, and not managed for a device outside it', async () => {
    expect(await read({}, 'heater')).toEqual({ state: 'starting' });
    const host = { getLatestPlanSnapshotForUi: () => ({ devices: [planDevice('heater', 'Water heater')] }) };
    expect(await read(host, 'gone')).toEqual({ state: 'not_managed' });
    expect(await read(host, undefined)).toEqual({ state: 'not_managed' });
  });

  it('serves the overview status and offers a new task while none runs', async () => {
    const payload = await read({
      getLatestPlanSnapshotForUi: () => ({ devices: [planDevice('heater', 'Water heater')] }),
      getCreateSmartTaskCandidateDevices: () => ({ state: 'ready', devices: [heater] }),
    }, 'heater');
    expect(payload).toMatchObject({
      state: 'ready',
      device: { id: 'heater', name: 'Water heater', status: STATUS, carName: null },
      task: { kind: 'none' },
      createDevice: { deviceId: 'heater', kind: 'temperature', offersQuickTargets: true },
    });
  });

  it('shows a running task and offers no second one', async () => {
    const payload = await read({
      getLatestPlanSnapshotForUi: () => ({ devices: [planDevice('heater', 'Water heater')] }),
      getCreateSmartTaskCandidateDevices: () => ({ state: 'ready', devices: [heater] }),
      getDeferredObjectiveActivePlansUiPayload: () => resolveActivePlanFixtures({ heater: plan }),
    }, 'heater');
    expect(payload).toMatchObject({
      state: 'ready',
      // Queued: its why line names when the cheaper hours start, so no "Next run" repeats it.
      task: { kind: 'active', goalLabel: 'Heat to 65 °C', whyLabel: expect.stringMatching(/\d\d:\d\d/), nextRunLabel: null },
      createDevice: null,
    });
  });

  it('keeps a task that reached its goal on the tile, and still offers no new one over it', async () => {
    const satisfied: ActivePlanFixture = { ...plan, latest: { ...plan.latest!, planStatus: 'satisfied' } };
    const payload = await read({
      getLatestPlanSnapshotForUi: () => ({ devices: [planDevice('heater', 'Water heater')] }),
      getCreateSmartTaskCandidateDevices: () => ({ state: 'ready', devices: [heater] }),
      getDeferredObjectiveActivePlansUiPayload: () => resolveActivePlanFixtures({ heater: satisfied }),
    }, 'heater');
    expect(payload).toMatchObject({ state: 'ready', task: { kind: 'active' }, createDevice: null });
  });

  it('offers the devices in the plan for the Device setting, filtered by the typed text', () => {
    const host = pelsHostDouble({ getLatestPlanSnapshotForUi: () => ({
      devices: [planDevice('b', 'Water heater'), planDevice('a', 'Garage charger')],
    }) });
    expect(buildDeviceWidgetChoices(host, '')).toEqual([
      { id: 'a', name: 'Garage charger' }, { id: 'b', name: 'Water heater' },
    ]);
    expect(buildDeviceWidgetChoices(host, 'WATER')).toEqual([{ id: 'b', name: 'Water heater' }]);
  });
});
