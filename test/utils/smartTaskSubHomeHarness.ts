// Shared harness for the multi-home smart-task scope-gate specs (integration
// app-lane battery + SDK-boundary flow-card e2e): boots the real app against
// two mock heaters and configures a sub-home + a device pin purely through the
// Homey SDK seams (`homes_config` / `device_home_assignments` settings writes,
// zones via the mock zone route) — the app's own serialized settings handler
// recomputes membership from them.
import { expect } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp } from './appTestUtils';
import { DEVICE_HOME_ASSIGNMENTS, HOMES_CONFIG } from '../../lib/utils/settingsKeys';
import type { DeferredObjectivePlanPreviewCandidate } from '../../lib/objectives/deferredObjectives';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

export const SUB_HOME_ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'Cabin', parent: 'z1' },
};
export const SUB_HOME = { homeId: 'h_cabin', name: 'Cabin', rootZoneId: 'z2', meterDeviceId: null };

// Managed temperature devices in the runtime-planned snapshot with an explicit
// 30..75 °C settable range (same fixture family as createDeferredObjectiveApp).
export const buildPlannedHeater = (id: string, name: string, zoneId: string): TargetDeviceSnapshot => ({
  id,
  name,
  zoneId,
  capabilities: ['target_temperature', 'measure_power'],
  targets: [{ id: 'target_temperature', value: 50, min: 30, max: 75, step: 0.5 }],
} as unknown as TargetDeviceSnapshot);

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

// Boot the real app, pin the runtime-planned snapshot (with zone ids), then
// configure the sub-home + the `heater-sub` pin through settings writes.
// `assertMembership` (integration-tier callers) additionally sanity-asserts the
// resolved membership before the lanes run; the e2e caller omits it and relies
// on observable behavior only.
// Returns the untyped app seam (matches `createApp`'s deliberate `any`).
export const initAppWithSubHome = async (
  options: { assertMembership?: boolean } = {},
): Promise<ReturnType<typeof createApp>> => {
  const sub = new MockDevice('heater-sub', 'Cabin heater', ['measure_power', 'target_temperature']);
  sub.setZone('z2');
  const main = new MockDevice('heater-main', 'Hall heater', ['measure_power', 'target_temperature']);
  main.setZone('z1');
  setMockDrivers({ driverA: new MockDriver('driverA', [sub, main]) });
  const app = createApp();
  await app.onInit();
  app.setSnapshotForTests([
    buildPlannedHeater('heater-sub', 'Cabin heater', 'z2'),
    buildPlannedHeater('heater-main', 'Hall heater', 'z1'),
  ]);
  mockHomeyInstance.settings.set(HOMES_CONFIG, { subHomes: [SUB_HOME] });
  mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, { 'heater-sub': 'h_cabin' });
  await settleAsyncSeams();
  if (options.assertMembership) {
    expect(app.homeMembership.getHomeIdForDevice('heater-sub')).toBe('h_cabin');
    expect(app.homeMembership.getHomeIdForDevice('heater-main')).toBe('main');
  }
  return app;
};
