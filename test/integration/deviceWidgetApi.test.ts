/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import { deviceOverrideKey } from '../../packages/shared-domain/src/settings/deviceOverrides';
import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUi/plan';
import type { CreateSmartTaskCandidateDevice } from '../../packages/contracts/src/widgetHostApi';
import { changeDeviceWidgetOverride, getDeviceWidget } from '../../widgets/device/src/api';
import { buildDeviceWidgetChoices } from '../../widgets/device/src/deviceWidgetPayload';
import { partialDouble } from '../helpers/partialDouble';
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
    hours: [{ startsAtMs: NOW + 2 * HOUR, endsAtMs: (NOW + 2 * HOUR) + 3_600_000, plannedKWh: 1 }], energyNeededKWh: 1, planStatus: 'on_track',
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
      // The task travels as the Smart task list's row, so a tap opens the same detail.
      task: {
        kind: 'active',
        row: { deviceId: 'heater', targetActionVerb: 'Heat to', targetValue: 65, whyLabel: expect.stringMatching(/\d\d:\d\d/) },
        nextRunLabel: null,
      },
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


const OVERRIDE_NOW = Date.UTC(2026, 9, 24, 13);
const KEY = deviceOverrideKey('heater');

const overrideFixture = () => {
  const values = new Map<string, unknown>();
  const settings: SettingsPort = {
    get: (key) => values.get(key) ?? null,
    getKeys: () => [...values.keys()],
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
  };
  const device = partialDouble<DecoratedDeviceSnapshot>({
    id: 'heater', managed: true, deviceType: 'temperature', isBatteryOrSolar: false,
    targets: [
      { id: 'target_humidity', unit: '%', min: 0, max: 100, value: 55 },
      { id: 'target_temperature', unit: '°C', min: 20, max: 85, value: 61, step: 0.5 },
    ],
  });
  const deviceControlSettings = new DeviceControlSettings(settings);
  const app = pelsHostDouble({
    getLatestPlanSnapshotForUi: () => ({ devices: [planDevice('heater', 'Water heater')] }),
    getSettingsUiManagedDevices: () => [device],
    deviceControlSettings,
    readGoverningModeTargetC: () => 65,
  });
  const homey = { app, settings, clock: { getTimezone: () => 'Europe/Oslo' } };
  return { homey, device, deviceControlSettings, values };
};

const saveDraft = {
  deviceId: 'heater', action: 'save', expected: null,
  draft: { temperature: '62.3', end: 'custom', date: '2026-10-25', at: '02:30' },
};

describe('Device widget override', () => {
  it('sets a normalized temperature until the first occurrence of a repeated local time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OVERRIDE_NOW);
    try {
      const { homey, values } = overrideFixture();
      const initial = await getDeviceWidget({ homey, body: { deviceId: 'heater' } });
      expect(initial).toMatchObject({ override: {
        active: null, defaultTemperatureC: 65, range: { min: 20, max: 85 }, timeZone: 'Europe/Oslo',
      } });
      const active = { untilMs: Date.UTC(2026, 9, 25, 0, 30), setting: { type: 'temperature', targetC: 62.5 } };
      expect(await changeDeviceWidgetOverride({ homey, body: saveDraft })).toEqual({ ok: true, active });
      expect(values.get(KEY)).toEqual(active);
      expect(await getDeviceWidget({ homey, body: { deviceId: 'heater' } })).toMatchObject({ override: { active } });

      const end = { deviceId: 'heater', action: 'end', expected: active };
      expect(await changeDeviceWidgetOverride({ homey, body: end })).toEqual({ ok: true, active: null });
      expect(values.get(KEY)).toEqual({ ...active, untilMs: OVERRIDE_NOW });
      const ended = await getDeviceWidget({ homey, body: { deviceId: 'heater' } });
      expect(ended).toMatchObject({ override: { active: null } });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { temperature: '19' },
    { date: '2026-10-xx' },
    { at: '25:00' },
    { date: '2026-11-04' },
  ])('rejects an invalid draft %j without persisting it', async (draft) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OVERRIDE_NOW);
    try {
      const { homey, values } = overrideFixture();
      const body = { ...saveDraft, draft: { ...saveDraft.draft, ...draft } };
      expect(await changeDeviceWidgetOverride({ homey, body })).toMatchObject({ ok: false });
      expect(values.has(KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes the open task’s ready-by time in the override controls', async () => {
    const { homey } = overrideFixture();
    homey.app.getDeferredObjectiveActivePlansUiPayload = () => resolveActivePlanFixtures({ heater: plan });
    const payload = await getDeviceWidget({ homey, body: { deviceId: 'heater' } });
    expect(payload).toMatchObject({
      task: { kind: 'active' },
      override: { taskDeadlineAtMs: plan.deadlineAtMs },
    });
  });

  it('checks device management and temperature-command authority on reads and writes', async () => {
    const { homey, device, deviceControlSettings, values } = overrideFixture();
    expect(await changeDeviceWidgetOverride({ homey, body: { ...saveDraft, deviceId: 'unknown' } }))
      .toMatchObject({ ok: false, refresh: true });
    device.managed = false;
    expect(await getDeviceWidget({ homey, body: { deviceId: 'heater' } })).toMatchObject({ override: null });
    expect(await changeDeviceWidgetOverride({ homey, body: saveDraft })).toMatchObject({ ok: false, refresh: true });
    device.managed = true;
    values.set('temperature_control_disabled_devices', { heater: true });
    deviceControlSettings.reloadTemperatureControlPolicy();
    expect(await getDeviceWidget({ homey, body: { deviceId: 'heater' } })).toMatchObject({ override: null });
    expect(await changeDeviceWidgetOverride({ homey, body: saveDraft })).toMatchObject({ ok: false, refresh: true });
    expect(values.has(KEY)).toBe(false);
  });

  it('asks for a refresh when the owner has already turned temperature control off', async () => {
    const { homey, values } = overrideFixture();
    const read = await getDeviceWidget({ homey, body: { deviceId: 'heater' } });
    expect(read).toMatchObject({ override: { active: null } });
    // The persisted policy can change before the settings event reaches the cached read.
    values.set('temperature_control_modes', { heater: 'external' });
    const body = { ...saveDraft, draft: { ...saveDraft.draft, end: 'two_hours' } };
    expect(await changeDeviceWidgetOverride({ homey, body })).toEqual({
      ok: false, error: 'This device is set to Keep the new temperature.', refresh: true,
    });
    expect(values.has(KEY)).toBe(false);
  });

  it.each([null, 'malformed'])('does not replace an unreadable stored override (%s)', async (failedRead) => {
    const { homey, values } = overrideFixture();
    const newer = { untilMs: Date.now() + HOUR, setting: { type: 'temperature', targetC: 67 } };
    values.set(KEY, newer);
    const read = homey.settings.get;
    homey.settings.get = (key) => key === KEY ? failedRead : read(key);
    const body = { ...saveDraft, draft: { ...saveDraft.draft, end: 'two_hours' } };
    expect(await changeDeviceWidgetOverride({ homey, body })).toMatchObject({
      ok: false, error: expect.stringContaining('device page in PELS'),
    });
    expect(values.get(KEY)).toEqual(newer);
  });

  it('preserves the newer override when an older widget asks to end it', async () => {
    const { homey, values } = overrideFixture();
    const newer = { untilMs: Date.now() + HOUR, setting: { type: 'temperature', targetC: 67 } };
    values.set(KEY, newer);
    const body = { deviceId: 'heater', action: 'end', expected: {
      ...newer, setting: { ...newer.setting, targetC: 62 },
    } };
    expect(await changeDeviceWidgetOverride({ homey, body })).toMatchObject({ ok: false, refresh: true });
    expect(values.get(KEY)).toEqual(newer);
  });
});
