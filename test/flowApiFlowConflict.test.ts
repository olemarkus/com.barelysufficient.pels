import { resolveFlowConflict, classifyFlowConflicts } from '../lib/flowApi/flowConflict';
import type { FlowCapabilityWrites } from '../lib/flowApi/userFlows';

const writesOf = (entries: Record<string, string[]>): FlowCapabilityWrites => (
  new Map(Object.entries(entries).map(([id, caps]) => [id, new Set(caps)]))
);

const hoiaxId = 'hoiax-1';
const zaptecId = 'zaptec-1';
const easeeId = 'easee-1';

describe('resolveFlowConflict', () => {
  it('returns the capabilities written by both a Flow and PELS', () => {
    const writes = writesOf({ [hoiaxId]: ['max_power_3000', 'measure_power'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000', 'max_power_2000', 'max_power', 'onoff']))
      .toEqual(['max_power_3000']);
  });

  it('returns every overlapping capability, not just the first', () => {
    const writes = writesOf({ [hoiaxId]: ['max_power_3000', 'onoff'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000', 'max_power_2000', 'max_power', 'onoff']))
      .toEqual(['max_power_3000', 'onoff']);
  });

  it('returns empty when the device has no Flow writes', () => {
    const writes = writesOf({ [zaptecId]: ['charging_button'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['max_power_3000'])).toEqual([]);
  });

  it('returns empty when Flow writes exist but none overlap the owned set', () => {
    const writes = writesOf({ [zaptecId]: ['target_temperature', 'measure_power'] });
    expect(resolveFlowConflict(writes, zaptecId, ['charging_button'])).toEqual([]);
  });

  it('returns empty for an empty owned-capability set', () => {
    const writes = writesOf({ [zaptecId]: ['charging_button'] });
    expect(resolveFlowConflict(writes, zaptecId, [])).toEqual([]);
  });

  it('detects a single-capability owned set (target_power) as a conflict', () => {
    const writes = writesOf({ [easeeId]: ['target_power', 'measure_power'] });
    expect(resolveFlowConflict(writes, easeeId, ['target_power'])).toEqual(['target_power']);
  });

  it('preserves owned-set ordering and de-duplicates a repeated owned capability', () => {
    const writes = writesOf({ [hoiaxId]: ['onoff', 'max_power'] });
    expect(resolveFlowConflict(writes, hoiaxId, ['onoff', 'max_power', 'onoff']))
      .toEqual(['onoff', 'max_power']);
  });
});

describe('classifyFlowConflicts', () => {
  it('returns one entry per conflicted device and omits clean ones', () => {
    const writes = writesOf({
      [hoiaxId]: ['max_power_3000'],
      [zaptecId]: ['installation_current_control'], // bridge write, not a native-owned cap
      [easeeId]: ['onoff'],
    });
    const result = classifyFlowConflicts(writes, [
      { deviceId: hoiaxId, ownedCapabilities: ['max_power_3000', 'max_power_2000', 'max_power', 'onoff'] },
      { deviceId: zaptecId, ownedCapabilities: ['charging_button'] },
      { deviceId: easeeId, ownedCapabilities: ['onoff'] },
    ]);
    expect(result).toEqual([
      { deviceId: hoiaxId, conflictingCapabilities: ['max_power_3000'] },
      { deviceId: easeeId, conflictingCapabilities: ['onoff'] },
    ]);
  });

  it('returns an empty array when no candidate device conflicts', () => {
    const writes = writesOf({ [zaptecId]: ['installation_current_control'] });
    const result = classifyFlowConflicts(writes, [
      { deviceId: zaptecId, ownedCapabilities: ['charging_button'] },
    ]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for no candidate devices', () => {
    expect(classifyFlowConflicts(writesOf({ [hoiaxId]: ['max_power'] }), [])).toEqual([]);
  });
});
