import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import {
  buildRescueCandidate,
  mapAppRescueReason,
  parseRescueRequest,
  RESCUE_DEADLINE_HORIZON_MS,
  resolveRescuableDeviceFromList,
} from '../../packages/shared-domain/src/starvationRescueShared';

// Pure shared logic for the budget-exempt rescue, used by BOTH the
// starvation_rescue widget and the overview device-card rescue path. These pin
// the guardrail so the two surfaces can never drift in what they let through.

const budget: StarvationRescueDevice = {
  deviceId: 'heater-1',
  deviceName: 'Hot water',
  cause: 'budget',
  accumulatedMs: 60_000,
  intendedNormalTargetC: 65,
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

  it('resolves a budget, task-free, known-target device', () => {
    expect(resolveRescuableDeviceFromList([budget], 'heater-1')).toEqual({ ok: true, targetTemperatureC: 65 });
  });

  it('rejects a capacity row as not_rescuable (the hard cap is physical)', () => {
    const capacity = { ...budget, cause: 'capacity' as const };
    expect(resolveRescuableDeviceFromList([capacity], 'heater-1')).toEqual({ ok: false, reason: 'not_rescuable' });
  });

  it('rejects a task-owning budget row as not_rescuable', () => {
    const owned = { ...budget, hasSmartTask: true };
    expect(resolveRescuableDeviceFromList([owned], 'heater-1')).toEqual({ ok: false, reason: 'not_rescuable' });
  });

  it('rejects a budget row with no known target as no_target', () => {
    const noTarget = { ...budget, intendedNormalTargetC: null };
    expect(resolveRescuableDeviceFromList([noTarget], 'heater-1')).toEqual({ ok: false, reason: 'no_target' });
  });

  it('rejects an unknown device id as not_rescuable', () => {
    expect(resolveRescuableDeviceFromList([budget], 'missing')).toEqual({ ok: false, reason: 'not_rescuable' });
  });
});

describe('buildRescueCandidate', () => {
  it('builds a soft temperature objective carrying both rescue permissions', () => {
    const candidate = buildRescueCandidate(65, 123_456);
    expect(candidate.kind).toBe('temperature');
    expect(candidate.enforcement).toBe('soft');
    expect(candidate).toMatchObject({ targetTemperatureC: 65, deadlineAtMs: 123_456 });
    expect(candidate.rescue).toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
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
