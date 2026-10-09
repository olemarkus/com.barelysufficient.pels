import type { AppContext } from '../../lib/app/appContext';
// Shared harness for the multi-home smart-task scope-gate specs (integration
// app-lane battery + SDK-boundary flow-card e2e): boots the real app against
// two managed mock heaters and configures a sub-home + a device pin purely
// through the Homey SDK seams (`managed_devices` / `homes_config` /
// `device_home_assignments` settings writes, zones via the mock zone route) —
// the app's own serialized settings handler recomputes membership from them.
import { expect } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp } from './appTestUtils';
import { DEVICE_HOME_ASSIGNMENTS, HOMES_CONFIG, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { HOME_CONFIG_ACTIVATION_VERSION } from '../../lib/home/homeConfig';
import type { DeferredObjectivePlanPreviewCandidate } from '../../lib/objectives/deferredObjectives';

export const SUB_HOME_ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'Cabin', parent: 'z1' },
};
export const SUB_HOME = { homeId: 'h_cabin', name: 'Cabin', rootZoneId: 'z2', meterDeviceId: null };

// A thermostat as Homey reports it, in `zoneId`, with an explicit 30..75 °C
// settable range and a metered idle draw (same family as createDeferredObjectiveApp).
const buildHomeyHeater = async (id: string, name: string, zoneId: string): Promise<MockDevice> => {
  const heater = new MockDevice(id, name, ['measure_power', 'target_temperature'], 'thermostat');
  heater.setCapabilityMetadata('target_temperature', { min: 30, max: 75, step: 0.5 });
  await heater.setCapabilityValue('target_temperature', 50);
  await heater.setCapabilityValue('measure_temperature', 45);
  await heater.setCapabilityValue('measure_power', 0);
  heater.setZone(zoneId);
  return heater;
};

export const tempCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC,
  deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
});

export const rescueCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  ...tempCandidate(targetTemperatureC),
  deadlineAtMs: Date.now() + 3 * 60 * 60 * 1000,
  rescue: { exemptFromBudget: 'always' },
});

// The app's settings handler is serialized+async and the transport's zone-tree
// fetch is detached; both settle within a few macrotask turns.
export const settleAsyncSeams = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

// Boot the real app on both managed heaters, then configure the sub-home + the
// `heater-sub` pin through settings writes.
// `assertMembership` additionally sanity-asserts the resolved membership before
// the lanes run. It reads `app.homeMembership` — an internal service — so it is
// for INTEGRATION-tier callers only; e2e callers must omit it and observe
// membership effects through an external seam.
// Returns the untyped app seam (matches `createApp`'s deliberate `any`).
export const initAppWithSubHome = async (
  options: { assertMembership?: boolean } = {},
): Promise<ReturnType<typeof createApp>> => {
  const sub = await buildHomeyHeater('heater-sub', 'Cabin heater', 'z2');
  const main = await buildHomeyHeater('heater-main', 'Hall heater', 'z1');
  setMockDrivers({ driverA: new MockDriver('driverA', [sub, main]) });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { 'heater-sub': true, 'heater-main': true });
  // Passive power: these lanes assert WRITE gating and membership, and the
  // default seeded reading (fresh 0 kW, full headroom) would let boot-time
  // rebuilds actuate the fixture heaters and race the membership settle.
  const app = createApp({ withoutPowerMeasurement: true });
  await app.onInit();
  mockHomeyInstance.settings.set(HOMES_CONFIG, {
    activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
    subHomes: [SUB_HOME],
  });
  mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, { 'heater-sub': 'h_cabin' });
  await settleAsyncSeams();
  if (options.assertMembership) {
    expect((app as AppContext).homeMembership?.getHomeIdForDevice('heater-sub')).toBe('h_cabin');
    expect((app as AppContext).homeMembership?.getHomeIdForDevice('heater-main')).toBe('main');
  }
  return app;
};
