import type Homey from 'homey';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices, onObservedState, onObservedStateRefresh } from '../helpers/deviceTransportHarness';
import { emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance, setMockGeolocation } from '../mocks/homey';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { TeslaChargingSession } from '../../lib/device/tesla/session';
import { applyNativeEvWiringOverlay } from '../../lib/device/nativeEvWiring';
import { resolveDeviceClassKey } from '../../lib/device/transport/managerHelpers';
import { confirmedTeslaCurrent } from '../../lib/device/tesla/charging';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const now = Date.parse('2026-10-13T10:00:00Z');
const cap = <T>(value: T, time = Date.now()) => ({ value, lastUpdated: new Date(time).toISOString() });
function devices(): HomeyDeviceLike[] {
  return [
    { id: 'battery', name: 'Car battery', class: 'sensor', driverId: 'homey:app:com.tesla.car:battery',
      data: { id: 'vehicle-1' }, capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: cap(true), charging_state: cap('Charging'), measure_charge_power: cap(4),
        measure_soc_level: cap(55), charging_port_cable: cap('IEC'), measure_charge_phases: cap(3) } },
    { id: 'location', name: 'Location', class: 'sensor', capabilities: ['measure_location_latitude', 'measure_location_longitude'], driverId: 'homey:app:com.tesla.car:location', data: { id: 'vehicle-1' },
      capabilitiesObj: { measure_location_latitude: cap(60), measure_location_longitude: cap(10) } },
    { id: 'car', name: 'Car', class: 'car', capabilities: ['car_state', 'car_shift_state', 'measure_car_drive_speed'], driverId: 'homey:app:com.tesla.car:car', data: { id: 'vehicle-1' },
      capabilitiesObj: { car_state: cap('online'), measure_car_drive_speed: cap(0), car_shift_state: cap('P') } },
  ];
}
function session() { return new TeslaChargingSession({ coordinates: () => ({ latitude: 60, longitude: 10 }) }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  // The hub location is read through the owner Web API; serve it from the mock even after a
  // spec replaced the REST client.
  setMockGeolocation(60, 10);
  setRestClient({ get: (path) => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body) });
});
afterEach(() => { vi.useRealTimers(); setMockGeolocation(59.91, 10.75); });

test('normalizes the charging sensor into EV capabilities, watts and state without becoming a home battery', () => {
  const battery = devices()[0]!;
  expect(resolveDeviceClassKey(battery)).toBe('evcharger');
  const result = applyNativeEvWiringOverlay(battery, battery.capabilities!, battery.capabilitiesObj as import('../../lib/device/managerControl').DeviceCapabilityMap);
  expect(result.binaryWriteCapabilityId).toBe('charging_on');
  expect(result.capabilityObj.measure_power?.value).toBe(4000);
  expect(result.capabilityObj.evcharger_charging_state?.value).toBe('plugged_in_charging');
});

test('admits a home AC session and retains it while stationary telemetry stays quiet', () => {
  const owner = session(); owner.observeDevices(devices());
  expect(owner.isAllowed('battery')).toBe(true);
  const first = owner.sessionId('battery');
  vi.advanceTimersByTime(2 * 60 * 60_000);
  expect(owner.isAllowed('battery')).toBe(true);
  expect(owner.sessionId('battery')).toBe(first);
});

test('rejects antipodal coordinates despite floating-point distance rounding', () => {
  const owner = new TeslaChargingSession({ coordinates: () => ({ latitude: 2.5, longitude: 0 }) });
  const initial = devices();
  initial[1]!.capabilitiesObj!.measure_location_latitude = cap(-2.5);
  initial[1]!.capabilitiesObj!.measure_location_longitude = cap(180);
  owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(false);
});

test.each([
  ['location', 'measure_location_latitude', 61],
  ['car', 'measure_car_drive_speed', 10],
  ['car', 'car_shift_state', 'D'],
  ['battery', 'charging_state', 'Disconnected'],
  ['battery', 'charging_state', 'Complete'],
  ['battery', 'charging_port_cable', 'CCS'],
  ['battery', 'measure_charge_power_dc', 20],
])('revokes home control on %s %s', (deviceId, capabilityId, value) => {
  const owner = session(); const initial = devices();
  if (capabilityId === 'measure_charge_power_dc') initial[0]!.capabilitiesObj!.measure_charge_power_dc = cap(0);
  owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(true);
  owner.observeCapability(String(deviceId), String(capabilityId), value);
  expect(owner.isAllowed('battery')).toBe(false);
});

test('requires fresh coordinates, not a generic location update, after disconnect', () => {
  const owner = session(); owner.observeDevices(devices()); expect(owner.isAllowed('battery')).toBe(true);
  vi.advanceTimersByTime(1000);
  owner.observeCapability('battery', 'charging_state', 'Disconnected');
  owner.observeCapability('battery', 'charging_state', 'Stopped');
  owner.observeCapability('location', 'location_last_update', new Date().toISOString());
  expect(owner.isAllowed('battery')).toBe(false);
  owner.observeCapability('location', 'measure_location_latitude', 60);
  owner.observeCapability('location', 'measure_location_longitude', 10);
  expect(owner.isAllowed('battery')).toBe(true);
});

test('matches sibling vehicle identities and refuses ambiguous locations', () => {
  const owner = session(); const initial = devices(); initial[1]!.data = { id: 'different-car' };
  owner.observeDevices(initial); expect(owner.isAllowed('battery')).toBe(false);
  owner.observeDevices(devices()); expect(owner.isAllowed('battery')).toBe(true);
  owner.observeDevice({ ...devices()[1]!, id: 'other-location' });
  expect(owner.isAllowed('battery')).toBe(false);
});

test('a reconnect requires new coordinate evidence', () => {
  const owner = session(); const initial = devices(); owner.setTrustEpoch('connected:0'); owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(true);
  vi.advanceTimersByTime(1000); owner.setTrustEpoch('connected:1'); owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(false);
});

test('current ceiling needs fresh actual current and power; lower draw is valid', () => {
  const caps = { measure_charge_current_max: cap(16), measure_charge_current: cap(6, now - 1), measure_charge_power: cap(4) };
  expect(confirmedTeslaCurrent(caps)).toBeUndefined();
  caps.measure_charge_current = cap(6);
  expect(confirmedTeslaCurrent(caps)?.value).toBe(16);
  caps.measure_charge_current = cap(20);
  expect(confirmedTeslaCurrent(caps)).toBeUndefined();
});

test('a stopped vehicle reports its prepared current without refreshing unchanged zero measurements', () => {
  const caps = { charging_on: cap(false, now - 1000), charging_state: cap('Stopped', now - 1000),
    measure_charge_current_max: cap(6), measure_charge_current: cap(0, now - 1000),
    measure_charge_power: cap(0, now - 1000) };
  expect(confirmedTeslaCurrent(caps)).toEqual({ value: 6, lastUpdated: cap(6).lastUpdated, setable: false });
  expect(caps.measure_charge_power).toEqual(cap(0, now - 1000));
  expect(caps.charging_on.value).toBe(false);
});

test.each([
  ['charging_on', true], ['charging_state', 'Charging'], ['charging_state', 'Starting'],
  ['charging_state', 'Disconnected'], ['charging_state', 'Complete'],
  ['measure_charge_current', 0.1], ['measure_charge_power', 0.001],
])('does not relax running confirmation for %s=%s', (id, value) => {
  const caps = { charging_on: cap(false, now - 1000), charging_state: cap('Stopped', now - 1000),
    measure_charge_current_max: cap(6), measure_charge_current: cap(0, now - 1000),
    measure_charge_power: cap(0, now - 1000), [id]: cap(value, now - 1000) };
  expect(confirmedTeslaCurrent(caps)).toBeUndefined();
});

test.each(['charging_on', 'charging_state', 'measure_charge_current', 'measure_charge_power'])(
  'paused preparation requires dated %s evidence', (id) => {
    const caps = { charging_on: cap(false), charging_state: cap('Stopped'),
      measure_charge_current_max: cap(6), measure_charge_current: cap(0, now - 1000),
      measure_charge_power: cap(0, now - 1000), [id]: undefined };
    expect(confirmedTeslaCurrent(caps)).toBeUndefined();
  },
);

test('realtime prepared-current feedback changes the step without inventing power or starting the vehicle', async () => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') },
    { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
      getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_3_phase',
        min: 0, max: 11040, step: 1380, excludeMin: 1, excludeMax: 4140 }) });
  try {
    await initWithLiveFeed(transport);
    const initial = devices();
    const powerAt = Date.now() - 1000;
    Object.assign(initial[0]!.capabilitiesObj!, { charging_on: cap(false), charging_state: cap('Stopped'),
      measure_charge_current_max: cap(16), measure_charge_current: cap(0, powerAt),
      measure_charge_power: cap(0, powerAt) });
    await seedTransportDevices(transport, initial);
    await emitCapability('battery', 'measure_charge_current_max', 6);
    expect(transport.getSnapshot()[0]).toMatchObject({ reportedStepId: '6a',
      measuredPowerKw: 0, measuredPowerObservedAtMs: powerAt, binaryControl: { on: false } });
    // A running ceiling echo still needs newer actual measurements.
    await emitCapability('battery', 'charging_on', true);
    await emitCapability('battery', 'charging_state', 'Charging');
    await emitCapability('battery', 'measure_charge_current_max', 8);
    expect(transport.getSnapshot()[0]).toMatchObject({ reportedStepId: '6a' });
    await emitCapability('battery', 'measure_charge_current', 8);
    await emitCapability('battery', 'measure_charge_power', 5.52);
    expect(transport.getSnapshot()[0]).toMatchObject({ reportedStepId: '8a', measuredPowerKw: 5.52 });
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});

test('transport discovers Tesla, permits home start/stop without a key, and revokes power and Flow requests when away', async () => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: {
    method: 'flow', confirmation: 'vehicle',
  } });
  const trigger = vi.fn().mockResolvedValue(true);
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') },
    { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
      getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_3_phase' }) }, undefined,
    { getFlowTriggerCard: () => ({ trigger }) });
  try {
    await initWithLiveFeed(transport);
    const [battery] = await seedTransportDevices(transport, devices());
    expect(battery).toMatchObject({ id: 'battery', isEvCharger: true, deviceClass: 'evcharger', available: true,
      measuredPowerKw: 4, binaryWriteCapabilityId: 'charging_on' });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    await transport.setCapability('battery', 'evcharger_charging', false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toContain('charging_on');
    await transport.requestSteppedLoadStep({ deviceId: 'battery',
      profile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 4140 }] },
      desiredStepId: '6a', planningPowerW: 4140, planningCurrentA: 6 });
    const requestId = trigger.mock.calls[0]![0].request_id;
    expect(transport.isSteppedRequestValid('battery', requestId)).toBe(true);
    await emitCapability('location', 'measure_location_latitude', 61);
    expect(transport.isSteppedRequestValid('battery', requestId)).toBe(false);
    expect(transport.getSnapshot()[0]).toMatchObject({ available: false, measuredPowerKw: 0 });
    await expect(transport.setCapability('battery', 'evcharger_charging', true)).rejects.toThrow('at home');
    expect(put).toHaveBeenCalledTimes(1);
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});

test('live built-in current selection rejects old Flow feedback before its snapshot refresh', async () => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: {
    method: 'flow', confirmation: 'vehicle',
  } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') },
    { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
      getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_3_phase' }) });
  try {
    await initWithLiveFeed(transport);
    await seedTransportDevices(transport, devices());
    expect(transport.reportSteppedLoadActualStep('battery', '6a', 4140)).toMatchObject({ kind: 'accepted' });
    const before = structuredClone(transport.getSnapshot()[0]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true,
      headers: { get: () => 'mock-homey-id' }, json: async () => ({ intersectedScopes: ['homey.flow'] }) }));
    await transport.chargingAccess.save({ key: 'test-private-key' });
    setRestClient({ get: vi.fn().mockResolvedValue({}), put: vi.fn() });
    await transport.chargingCurrentControl.save('battery', { method: 'built_in', confirmation: 'vehicle' });
    // No successful device refresh has projected the committed method yet.
    expect(transport.getSnapshot()[0]?.controlAdapter?.currentControl).toBeUndefined();
    expect(transport.reportSteppedLoadActualStep('battery', '16a', 11040)).toEqual({ kind: 'native_control' });
    expect(transport.getSnapshot()[0]).toEqual(before);
  } finally {
    transport.chargingAccess.remove();
    mockHomeyInstance.settings.unset('charging_current_control');
    vi.unstubAllGlobals();
  }
});


test('rejects a future coordinate even when the other coordinate is fresh', () => {
  const owner = session(); const initial = devices();
  initial[1]!.capabilitiesObj!.measure_location_latitude = cap(60, now + 60_000);
  owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(false);
});

test('removing a companion revokes authorization until a complete home session is observed', () => {
  const owner = session(); const initial = devices(); owner.observeDevices(initial);
  expect(owner.isAllowed('battery')).toBe(true);
  owner.retainDevices([initial[0]!, initial[2]!]);
  expect(owner.isAllowed('battery')).toBe(false);
  expect(owner.observedIds()).not.toContain('location');
});

test.each([
  ['location', false], ['car', false], ['location', true],
] as const)('full refresh removes %s before publishing Tesla eligibility (ignored battery: %s)', async (removed, ignoredBattery) => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  try {
    await initWithLiveFeed(transport);
    const initial = devices();
    await seedTransportDevices(transport, initial);
    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({ available: true, measuredPowerKw: 4 });
    const published: boolean[] = [];
    onObservedStateRefresh(transport, () => {
      published.push(transport.getSnapshotByDeviceId('battery')?.available === true);
    });
    const remaining = initial.filter((device) => device.id !== removed);
    if (ignoredBattery) delete remaining[0]!.capabilitiesObj!.measure_soc_level;
    await seedTransportDevices(transport, remaining);
    expect(published).toEqual([false]);
    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({ available: false, measuredPowerKw: 0 });
    await expect(transport.setCapability('battery', 'evcharger_charging', true)).rejects.toThrow('at home');
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});

test('transient empty and targeted reads preserve accepted Tesla companion membership', async () => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  try {
    await initWithLiveFeed(transport);
    const initial = devices();
    await seedTransportDevices(transport, initial);
    const revision = transport.chargingCurrentControl.sessions.controlRevision('battery');
    await seedTransportDevices(transport, []);
    expect(transport.chargingCurrentControl.sessions.controlRevision('battery')).toBe(revision);
    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({ available: true, measuredPowerKw: 4 });
    await seedTransportDevices(transport, [initial[0]!], { targetedRefresh: true });
    expect(transport.chargingCurrentControl.sessions.controlRevision('battery')).toBe(revision);
    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({ available: true, measuredPowerKw: 4 });
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});


test.each(['device_update', 'device_fetch'] as const)(
  '%s ignores malformed Tesla battery and companion reads without revoking accepted home control', async (source) => {
    vi.useRealTimers();
    mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
      { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
    try {
      await initWithLiveFeed(transport);
      const initial = devices();
      await seedTransportDevices(transport, initial);
      const before = transport.getSnapshotByDeviceId('battery')!;
      if (!hasObservedMeasuredPower(before)) throw new Error('Expected Tesla power observation');
      const powerObservedAt = before.measuredPowerObservedAtMs;
      expect(Number.isFinite(powerObservedAt)).toBe(true);
      expect(before).toMatchObject({ available: true, measuredPowerKw: 4 });
      const malformed = initial.map((device) => ({ ...device, available: false,
        capabilitiesObj: { ...device.capabilitiesObj } }));
      delete malformed[0]!.capabilitiesObj.measure_soc_level;
      malformed[1]!.capabilitiesObj.measure_location_latitude = { value: 61 };
      malformed[2]!.capabilitiesObj.measure_car_drive_speed = { value: 30 };
      if (source === 'device_update') {
        for (const device of malformed) emitDeviceUpdate(device);
      } else {
        await seedTransportDevices(transport, malformed);
      }
      expect(transport.getSnapshot()[0]).toMatchObject({ available: true, measuredPowerKw: 4,
        measuredPowerObservedAtMs: powerObservedAt });
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: vi.fn(), put });
      await transport.setCapability('battery', 'evcharger_charging', false);
      expect(put).toHaveBeenCalledTimes(1);
      // A later complete companion read must still revoke the session.
      emitDeviceUpdate({ ...initial[1]!, capabilitiesObj: {
        ...initial[1]!.capabilitiesObj, measure_location_latitude: cap(61),
      } });
      expect(transport.getSnapshot()[0]).toMatchObject({ available: false, measuredPowerKw: 0 });
      await expect(transport.setCapability('battery', 'evcharger_charging', true)).rejects.toThrow('at home');
    } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
  },
);


test('fresh home evidence restores availability without restoring old power or overriding Homey unavailability', async () => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  try {
    await initWithLiveFeed(transport);
    const initial = devices();
    initial[0]!.available = true;
    await seedTransportDevices(transport, initial);
    await emitCapability('location', 'measure_location_latitude', 61);
    const away = transport.getSnapshotByDeviceId('battery')!;
    if (!hasObservedMeasuredPower(away)) throw new Error('Expected excluded home-power observation');
    const excludedPowerAt = away.measuredPowerObservedAtMs;
    expect(Number.isFinite(excludedPowerAt)).toBe(true);
    expect(transport.getSnapshot()[0]).toMatchObject({ available: false, measuredPowerKw: 0 });
    const observed = vi.fn();
    onObservedState(transport, observed);
    await emitCapability('location', 'measure_location_latitude', 60);
    await emitCapability('location', 'measure_location_longitude', 10);
    expect(transport.getSnapshot()[0]).toMatchObject({ available: true, measuredPowerKw: 0,
      measuredPowerObservedAtMs: excludedPowerAt });
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'battery',
      observed: expect.objectContaining({ available: true }) }));
    await emitCapability('battery', 'measure_charge_power', 3);
    expect(transport.getSnapshot()[0]).toMatchObject({ measuredPowerKw: 3 });
    emitDeviceUpdate({ ...initial[0]!, available: false });
    await emitCapability('location', 'measure_location_latitude', 60);
    await emitCapability('location', 'measure_location_longitude', 10);
    expect(transport.getSnapshot()[0]).toMatchObject({ available: false, measuredPowerKw: 0 });
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});


test.each([
  ['device_update', 'Calibrating'], ['device_update', 'NoPower'], ['device_update', 'Unknown'],
  ['device_fetch', 'Calibrating'], ['device_fetch', 'NoPower'], ['device_fetch', 'Unknown'],
] as const)('%s accepts %s as unavailable without inventing a plug observation', async (source, state) => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  try {
    await initWithLiveFeed(transport);
    const initial = devices();
    await seedTransportDevices(transport, initial);
    const previous = transport.getSnapshot()[0]!;
    if (!isEvObserved(previous)) throw new Error('Expected Tesla EV observation');
    const plugObservedAt = previous.evChargingStateObservedAtMs;
    expect(previous.evChargingState).toBe('plugged_in_charging');
    expect(Number.isFinite(plugObservedAt)).toBe(true);
    const updated = initial.map((device) => device.id === 'battery'
      ? { ...device, capabilitiesObj: { ...device.capabilitiesObj, charging_state: cap(state) } } : device);
    if (source === 'device_update') emitDeviceUpdate(updated[0]);
    else await seedTransportDevices(transport, updated);
    expect(transport.getSnapshot()[0]).toMatchObject({ available: false, measuredPowerKw: 0,
      evChargingState: 'plugged_in_charging', evChargingStateObservedAtMs: plugObservedAt });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    await expect(transport.setCapability('battery', 'evcharger_charging', true)).rejects.toThrow('at home');
    expect(put).not.toHaveBeenCalled();
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});

test('a Tesla first observed in Unknown state is not discovered as a manageable charger', async () => {
  vi.useRealTimers();
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  await initWithLiveFeed(transport);
  const initial = devices();
  initial[0]!.capabilitiesObj!.charging_state = cap('Unknown');
  await seedTransportDevices(transport, initial);
  expect(transport.getSnapshot().find((device) => device.id === 'battery')).toBeUndefined();
});


test.each([2.5, undefined])('transport forwards projected power %s without inventing a zero sample', async (powerKw) => {
  vi.useRealTimers();
  mockHomeyInstance.settings.set('charging_current_control', { battery: { method: 'flow', confirmation: 'vehicle' } });
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
    { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
  try {
    await initWithLiveFeed(transport);
    await seedTransportDevices(transport, devices());
    // Exercise the common host's projection contract, independently of a vendor's current power policy.
    const project = vi.spyOn(transport.chargingCurrentControl, 'projectControl')
      .mockImplementation((snapshot) => ({ ...snapshot, measuredPowerKw: powerKw }));
    try {
      await emitCapability('location', 'measure_location_latitude', 60);
      expect(transport.getSnapshot()[0]).toMatchObject({ measuredPowerKw: powerKw ?? 4 });
    } finally { project.mockRestore(); }
  } finally { mockHomeyInstance.settings.unset('charging_current_control'); }
});
