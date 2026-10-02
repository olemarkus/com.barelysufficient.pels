import { describe, expect, it } from 'vitest';
import { isRestoreLiveEligibleDevice } from '../../lib/plan/restore/devices';
import { buildExecutableDeviceIntent } from '../../lib/executor/executablePlanProjection';
import { buildPlanDevice } from '../utils/planTestUtils';

/**
 * `commandAuthority` is the gate, and a smart task can open it on its own.
 *
 * Every other fixture in the suite resolves it the way production does — the
 * owner's Power-limit toggle ANDed with `managed` — so in nearly every spec it
 * agrees with the toggle, and a consumer wired to the toggle instead would still
 * pass. Deferred admission is the one thing that separates them: it ORs
 * authority on for a device the owner has NOT power-limited, so the task can
 * drive it.
 *
 * These cases pin that split directly, without the admission machinery, at two
 * consumers that decide whether PELS acts: restore candidacy, and the executor's
 * binary intent.
 */
const rescuedByTask = () => buildPlanDevice({
  id: 'charger',
  binaryCapabilityId: 'onoff',
  currentOn: false,
  plannedState: 'keep',
  // The owner's Power-limit toggle is off — `controllable: false` — and the task
  // granted authority anyway.
  control: { managed: true, commandAuthority: true },
});

const ignoredByPels = () => buildPlanDevice({
  id: 'charger',
  binaryCapabilityId: 'onoff',
  currentOn: false,
  plannedState: 'keep',
  control: { managed: true, commandAuthority: false },
});

describe('a smart task can grant command authority on its own', () => {
  it('admits a task-rescued device to restore even with power limiting off', () => {
    expect(isRestoreLiveEligibleDevice(rescuedByTask())).toBe(true);
  });

  it('keeps a device without authority out of restore', () => {
    expect(isRestoreLiveEligibleDevice(ignoredByPels())).toBe(false);
  });

  it('drives the binary axis as a controlled restore for a task-rescued device the plan keeps', () => {
    expect(buildExecutableDeviceIntent(rescuedByTask())).toEqual(expect.objectContaining({
      commandAuthority: true,
      binary: expect.objectContaining({ desiredOn: true, source: 'controlled' }),
    }));
  });

  it('marks the binary intent uncontrolled when PELS has no authority', () => {
    expect(buildExecutableDeviceIntent(ignoredByPels())).toEqual(expect.objectContaining({
      commandAuthority: false,
      binary: expect.objectContaining({ source: 'uncontrolled' }),
    }));
  });
});
