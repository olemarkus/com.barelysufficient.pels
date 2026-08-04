import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import {
  buildRescueCandidate,
  mapAppRescueReason,
  parseRescueRequest,
  RESCUE_DEADLINE_HORIZON_MS,
  resolveRescuableDeviceFromList,
} from '../../packages/shared-domain/src/starvationRescueShared';

// Pure shared logic for the rescue, used by BOTH the starvation_rescue widget
// and the overview device-card rescue path. These pin the guardrail so the two
// surfaces can never drift in what they let through.

const heldBack: StarvationRescueDevice = {
  deviceId: 'heater-1',
  deviceName: 'Hot water',
  accumulatedMs: 60_000,
  intendedNormalTargetC: 65,
  smartTaskHomeScope: 'main',
  hasSmartTask: false,
};

describe('parseRescueRequest', () => {
  it('parses a bare device id', () => {
    expect(parseRescueRequest({ deviceId: 'heater-1' })).toEqual({ deviceId: 'heater-1' });
  });

  it('carries a finite echoed deadline through', () => {
    expect(parseRescueRequest({ deviceId: 'heater-1', deadlineAtMs: 1000 }))
      .toEqual({ deviceId: 'heater-1', deadlineAtMs: 1000 });
  });

  it('drops a non-finite deadline', () => {
    expect(parseRescueRequest({ deviceId: 'heater-1', deadlineAtMs: Number.NaN }))
      .toEqual({ deviceId: 'heater-1' });
  });

  it('rejects malformed bodies', () => {
    expect(parseRescueRequest(null)).toBeNull();
    expect(parseRescueRequest([])).toBeNull();
    expect(parseRescueRequest({ deviceId: '   ' })).toBeNull();
  });
});

describe('resolveRescuableDeviceFromList', () => {
  it('maps a null list to unavailable', () => {
    expect(resolveRescuableDeviceFromList(null, 'heater-1')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('resolves a task-free, known-target device', () => {
    expect(resolveRescuableDeviceFromList([heldBack], 'heater-1')).toEqual({ ok: true, targetTemperatureC: 65 });
  });

  it('preserves transient Main authority as unavailable while the row remains visible', () => {
    const unavailable = { ...heldBack, smartTaskHomeScope: 'unavailable' as const };
    expect(resolveRescuableDeviceFromList([unavailable], 'heater-1'))
      .toEqual({ ok: false, reason: 'unavailable' });
  });

  // Removed 2026-08-04: the guardrail used to reject any row whose momentary
  // cause bucket read `capacity`. `buildRescueCandidate` (below) grants
  // `pauseLowerPriorityDevices` and `limitLowerPriorityDevices` precisely
  // because it cannot see which constraint binds, and both clear room UP TO the
  // hard cap — so a capacity-held row had a working rescue withheld from it on
  // the strength of a bucket that flipped mid-hold.
  // The predicate now reads only the target, the task flag, and the home scope —
  // there is no constraint field left on the row for it to reject. The
  // end-to-end proof that a capacity-attributed device reaches this point lives
  // in `test/unit/deviceDiagnosticsService.test.ts`.
  it('rescues a held-back row on the strength of its target alone', () => {
    const longHeld = { ...heldBack, accumulatedMs: 3 * 60 * 60_000 };
    expect(resolveRescuableDeviceFromList([longHeld], 'heater-1')).toEqual({ ok: true, targetTemperatureC: 65 });
    expect(Object.keys(heldBack)).not.toContain('cause');
  });

  it('rejects a task-owning row as not_rescuable', () => {
    const owned = { ...heldBack, hasSmartTask: true };
    expect(resolveRescuableDeviceFromList([owned], 'heater-1')).toEqual({ ok: false, reason: 'not_rescuable' });
  });

  it('rejects a budget row with no known target as no_target', () => {
    const noTarget = { ...heldBack, intendedNormalTargetC: null };
    expect(resolveRescuableDeviceFromList([noTarget], 'heater-1')).toEqual({ ok: false, reason: 'no_target' });
  });

  it('rejects an unknown device id as not_rescuable', () => {
    expect(resolveRescuableDeviceFromList([heldBack], 'missing')).toEqual({ ok: false, reason: 'not_rescuable' });
  });
});

describe('buildRescueCandidate', () => {
  it('builds a soft temperature objective carrying all three rescue permissions', () => {
    const candidate = buildRescueCandidate(65, 123_456);
    expect(candidate.kind).toBe('temperature');
    expect(candidate.enforcement).toBe('soft');
    expect(candidate).toMatchObject({ targetTemperatureC: 65, deadlineAtMs: 123_456 });
    // A starved device can be held by budget OR by capacity and these surfaces
    // cannot see which, so the rescue requests every permission and lets the
    // server-side gate drop whichever would be inert on this device.
    expect(candidate.rescue).toEqual({
      exemptFromBudget: 'always',
      limitLowerPriorityDevices: 'always',
      pauseLowerPriorityDevices: 'always',
    });
  });
});

describe('mapAppRescueReason', () => {
  it('maps the write-refusal reasons onto the retryable write_conflict lane', () => {
    expect(mapAppRescueReason('write_refused')).toBe('write_conflict');
    expect(mapAppRescueReason('write_conflict')).toBe('write_conflict');
  });

  it('passes through the device honesty reasons', () => {
    expect(mapAppRescueReason('device_not_found')).toBe('device_not_found');
    expect(mapAppRescueReason('device_not_planned')).toBe('device_not_planned');
    expect(mapAppRescueReason('device_not_eligible')).toBe('device_not_eligible');
  });

  it('collapses an unknown reason to invalid_candidate', () => {
    expect(mapAppRescueReason('something_else')).toBe('invalid_candidate');
  });
});

describe('RESCUE_DEADLINE_HORIZON_MS', () => {
  it('is the 3-hour near-term horizon', () => {
    expect(RESCUE_DEADLINE_HORIZON_MS).toBe(3 * 60 * 60 * 1000);
  });
});
